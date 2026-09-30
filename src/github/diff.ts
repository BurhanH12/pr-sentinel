import type { Octokit } from "@octokit/rest";
import type { PullRequestFile, ReviewFileSelection } from "../types.js";
import { logger } from "../utils/logger.js";

/*
 * Fetch every changed file in the PR (paginated), strip ones matching the
 * configured exclude globs, and cap at `maxFiles` so a 500-file PR can't
 * blow up the Cursor agent's context window.
 */
/** Max omitted paths listed in the PR summary partial-review section. */
export const MAX_OMITTED_PATHS_IN_SUMMARY = 20;

export async function fetchPRFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  excludePatterns: string[],
  maxFiles: number
): Promise<ReviewFileSelection> {
  const all: PullRequestFile[] = [];

  let page = 1;
  // Bound the pagination loop — GitHub caps PR files at 3000, but defending
  // against an infinite loop in case the API misbehaves.
  const maxPages = 50;

  while (page <= maxPages) {
    const { data } = await octokit.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
      page,
    });

    if (data.length === 0) break;

    for (const f of data) {
      all.push({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch,
      });
    }

    if (data.length < 100) break;
    page += 1;
  }

  logger.debug(
    { owner, repo, prNumber, total: all.length },
    "Fetched PR files"
  );

  const selection = selectReviewFiles(all, excludePatterns, maxFiles);

  if (selection.excludedCount > 0) {
    logger.debug(
      {
        before: all.length,
        after: selection.files.length + selection.truncatedCount,
      },
      "Filtered excluded files"
    );
  }

  if (selection.truncatedCount > 0) {
    logger.warn(
      {
        count: selection.files.length + selection.truncatedCount,
        maxFiles,
      },
      "PR exceeds maxFilesPerRun; truncating. Consider splitting this PR."
    );
  }

  return selection;
}

/**
 * Pure selection: apply exclude globs then cap at maxFiles.
 * Exported for unit tests.
 */
export function selectReviewFiles(
  all: PullRequestFile[],
  excludePatterns: string[],
  maxFiles: number
): ReviewFileSelection {
  const filtered = all.filter(
    (f) => !matchesAnyPattern(f.filename, excludePatterns)
  );
  const excludedCount = all.length - filtered.length;

  if (filtered.length > maxFiles) {
    const prioritized = prioritizeReviewFiles(filtered);
    const files = prioritized.slice(0, maxFiles);
    const omittedFiles = prioritized
      .slice(maxFiles)
      .map((f) => f.filename)
      .slice(0, MAX_OMITTED_PATHS_IN_SUMMARY);
    return {
      files,
      allChangedPaths: all.map((f) => f.filename),
    totalFiles: all.length,
      excludedCount,
      truncatedCount: filtered.length - maxFiles,
      omittedFiles,
      maxFiles,
    };
  }

  return {
    files: filtered,
    allChangedPaths: all.map((f) => f.filename),
    totalFiles: all.length,
    excludedCount,
    truncatedCount: 0,
    omittedFiles: [],
    maxFiles,
  };
}

export function prioritizeReviewFiles(
  files: PullRequestFile[]
): PullRequestFile[] {
  return files
    .map((file, index) => ({ file, index }))
    .sort((a, b) => {
      const priorityDelta =
        reviewPriority(a.file.filename) - reviewPriority(b.file.filename);
      if (priorityDelta !== 0) return priorityDelta;

      const sizeDelta = diffSize(b.file) - diffSize(a.file);
      if (sizeDelta !== 0) return sizeDelta;

      return a.index - b.index;
    })
    .map((entry) => entry.file);
}

function diffSize(file: PullRequestFile): number {
  return file.additions + file.deletions;
}

function reviewPriority(filename: string): number {
  if (isSecuritySensitivePath(filename)) return 0;
  if (isMigrationPath(filename)) return 1;
  if (isApiRoutePath(filename)) return 2;
  if (isPackageOrEnvConfigPath(filename)) return 3;
  return 4;
}

function isSecuritySensitivePath(filename: string): boolean {
  return /(^|\/)(auth|security|session|sessions|permission|permissions|guard|guards|jwt|oauth|password|token|tokens|crypto)(\/|\.|-|_)/i.test(
    filename
  );
}

function isMigrationPath(filename: string): boolean {
  return /(^|\/)migrations?\//i.test(filename);
}

function isApiRoutePath(filename: string): boolean {
  return (
    /(^|\/)apps\/api\//i.test(filename) ||
    /(^|\/)api\//i.test(filename) ||
    /\.(controller|resolver|route|handler)\.(ts|tsx|js|jsx)$/i.test(filename) ||
    /(^|\/)route\.(ts|js)$/i.test(filename)
  );
}

function isPackageOrEnvConfigPath(filename: string): boolean {
  return (
    /(^|\/)package\.json$/i.test(filename) ||
    /(^|\/)\.env(\.[^/]*)?$/i.test(filename) ||
    /(^|\/)(env|environment)\.(ts|js|json)$/i.test(filename) ||
    /(^|\/)config\/.*env/i.test(filename)
  );
}

export function changedPathSet(files: PullRequestFile[]): Set<string> {
  return new Set(files.map((f) => f.filename));
}

export function formatDiffForPrompt(files: PullRequestFile[]): string {
  if (files.length === 0) return "No reviewable files changed.";

  return files
    .map((f) => {
      const header = `### ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})`;
      const patch = f.patch
        ? `\`\`\`diff\n${f.patch}\n\`\`\``
        : "_Binary, renamed-only, or empty file — no diff available_";
      return `${header}\n\n${patch}`;
    })
    .join("\n\n---\n\n");
}

// ─── Glob matching ───────────────────────────────────────────────────────────

/*
 * Tiny zero-dep glob matcher supporting `*`, `**`, and `?`. Equivalent in
 * behaviour to minimatch for the simple patterns we care about (e.g. "*.lock",
 * "dist/**", "*.generated.*"). Avoid pulling minimatch just for this.
 */
export function matchesAnyPattern(
  filename: string,
  patterns: string[]
): boolean {
  return patterns.some((pattern) => matchesPattern(filename, pattern));
}

function matchesPattern(filename: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__GLOBSTAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/__GLOBSTAR__/g, ".*")
    .replace(/\?/g, "[^/]");

  return new RegExp(`^${regexStr}$`).test(filename);
}
