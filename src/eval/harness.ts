/*
 * Runs the eval's cases through the real reviewer (IMPROVEMENT-PLAN §2.4,
 * §2.11). The miner and injector produce EvalCase objects entirely from git
 * history and mutation; this file is the piece that actually checks a case
 * out into a throwaway worktree, builds the same file selection the
 * orchestrator would build for a real PR, and calls runPRReview against it.
 *
 * Deliberately sequential (see runCases): each call is an unbounded-cost
 * model invocation, and the reviewer already applies its own concurrency
 * limits when driven from the orchestrator.
 */

import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { simpleGit } from "simple-git";
import { runPRReview } from "../agent/runner.js";
import { selectReviewFiles } from "../github/diff.js";
import { ORG_DEFAULTS } from "../config/loader.js";
import type {
  CaseOutcome,
  EvalCase,
  ReportedFinding,
} from "./types.js";
import type {
  PullRequestContext,
  PullRequestFile,
  ReviewFileSelection,
  ReviewRulesConfig,
} from "../types.js";
import { logger } from "../utils/logger.js";

export interface RunCaseOptions {
  /** Config the review runs under. Defaults to ORG_DEFAULTS. */
  config?: ReviewRulesConfig;
  /** Run each case twice and record the second run for the stability measure (§2.11). */
  runTwice?: boolean;
  /** Directory for the throwaway worktree. Defaults to os.tmpdir(). */
  workDir?: string;
}

/* Strips the "a/"/"b/" prefix git diff prepends to paths. */
function stripDiffPathPrefix(path: string): string {
  return path.replace(/^[ab]\//, "");
}

/*
 * Map git's `diff --name-status` status letters onto PullRequestFile["status"].
 * Renames and copies carry a similarity score suffix (e.g. "R100") that
 * `startsWith` handles without a separate regex.
 */
function mapStatus(letter: string): PullRequestFile["status"] {
  if (letter.startsWith("A")) return "added";
  if (letter.startsWith("D")) return "removed";
  if (letter.startsWith("R")) return "renamed";
  if (letter.startsWith("C")) return "copied";
  return "modified";
}

/*
 * Count added/deleted lines from a unified diff's hunk lines, the same
 * counting GitHub's PR-files API does. `+++`/`---` header lines are excluded
 * explicitly since they also start with "+"/"-".
 */
function countAdditionsDeletions(patch: string): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

/*
 * Turn a git-generated per-file patch into the GitHub-style patch body
 * runPRReview's diff formatter and the model both expect: hunks only,
 * starting at the first "@@" line, with the "diff --git" / "index" / "---" /
 * "+++" headers stripped.
 */
function extractHunksOnly(patch: string): string {
  const idx = patch.indexOf("@@");
  return idx === -1 ? "" : patch.slice(idx);
}

/*
 * Build the reviewer's file selection from a git range, mirroring what
 * github/diff.ts's fetchPRFiles does against the GitHub API: a per-file
 * unified diff becomes a PullRequestFile with a GitHub-shaped patch, then
 * selectReviewFiles applies the config's exclude globs and file cap. Exported
 * for testing.
 */
export async function buildFileSelection(
  repoPath: string,
  baseSha: string,
  headSha: string,
  config: ReviewRulesConfig
): Promise<ReviewFileSelection> {
  const git = simpleGit({ baseDir: resolve(repoPath) });

  const nameStatusOut = await git.raw([
    "diff",
    "--name-status",
    baseSha,
    headSha,
  ]);

  const files: PullRequestFile[] = [];
  for (const line of nameStatusOut.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const statusLetter = parts[0] ?? "";
    // Renames/copies carry two paths (old\tnew); the new path is the one the
    // reviewed revision actually has content at.
    const path = parts[parts.length - 1] ?? "";
    if (!path) continue;

    const rawPatch = await git.raw([
      "diff",
      "--unified=3",
      baseSha,
      headSha,
      "--",
      path,
    ]);
    const patch = extractHunksOnly(rawPatch);
    const { additions, deletions } = countAdditionsDeletions(patch);

    files.push({
      filename: stripDiffPathPrefix(path),
      status: mapStatus(statusLetter),
      additions,
      deletions,
      patch: patch.length > 0 ? patch : undefined,
    });
  }

  return selectReviewFiles(files, config.excludePatterns, config.maxFilesPerRun);
}

/*
 * Synthesise the PR context a mined or injected commit stands in for. The
 * synthetic PR number is deterministic (derived from headSha) rather than
 * random, so the same case always produces the same context across runs -
 * useful for reproducing a specific eval result.
 */
export function buildPullRequestContext(
  evalCase: EvalCase,
  repoFullName = "pr-sentinel-eval/eval"
): PullRequestContext {
  return {
    owner: repoFullName.split("/")[0] ?? "eval",
    repo: repoFullName.split("/")[1] ?? "eval",
    repoFullName,
    prNumber: syntheticPrNumber(evalCase.headSha),
    prTitle: evalCase.title,
    prBody: "",
    baseBranch: evalCase.baseSha,
    headBranch: evalCase.headSha,
    headSha: evalCase.headSha,
    authorLogin: "eval-bot",
    cloneUrl: evalCase.repoPath,
    requestedReviewers: [],
  };
}

/* Deterministic small positive integer derived from a sha, for the synthetic PR number. */
function syntheticPrNumber(sha: string): number {
  const hex = sha.slice(0, 8);
  const n = parseInt(hex, 16);
  return (Number.isFinite(n) ? n % 1_000_000 : 1) + 1;
}

async function checkoutWorktree(
  repoPath: string,
  headSha: string,
  workDir: string,
  caseId: string
): Promise<string> {
  const worktreePath = resolve(join(workDir, caseId));
  await rm(worktreePath, { recursive: true, force: true });
  const git = simpleGit({ baseDir: resolve(repoPath) });
  await git.raw(["worktree", "add", "--detach", worktreePath, headSha]);
  return worktreePath;
}

async function removeWorktree(
  repoPath: string,
  worktreePath: string
): Promise<void> {
  try {
    const git = simpleGit({ baseDir: resolve(repoPath) });
    await git.raw(["worktree", "remove", "--force", worktreePath]);
  } catch (err) {
    logger.warn({ err, worktreePath }, "Failed to remove eval worktree");
  }
}

function toReportedFindings(
  issues: { path: string; line: number; severity: ReportedFinding["severity"] }[]
): ReportedFinding[] {
  return issues.map((i) => ({ path: i.path, line: i.line, severity: i.severity }));
}

/*
 * Run one review against a real checkout of evalCase.headSha and map the
 * result into a CaseOutcome. A thrown review (SDK failure, worktree failure)
 * becomes an errored outcome rather than a crash that loses the whole run -
 * one bad case must never take down the rest of the eval.
 */
export async function runCase(
  evalCase: EvalCase,
  options: RunCaseOptions = {}
): Promise<CaseOutcome> {
  const config = options.config ?? ORG_DEFAULTS;
  const workDir = options.workDir ?? tmpdir();
  await mkdir(workDir, { recursive: true });

  const log = logger.child({ caseId: evalCase.id, tier: evalCase.tier });

  let worktreePath: string | null = null;
  try {
    worktreePath = await checkoutWorktree(
      evalCase.repoPath,
      evalCase.headSha,
      workDir,
      evalCase.id
    );

    const selection = await buildFileSelection(
      evalCase.repoPath,
      evalCase.baseSha,
      evalCase.headSha,
      config
    );
    const pr = buildPullRequestContext(evalCase);

    const runStartedAt = Date.now();
    const result = await runPRReview(pr, selection, config, worktreePath);
    const wallClockMs = Date.now() - runStartedAt;

    const outcome: CaseOutcome = {
      caseId: evalCase.id,
      tier: evalCase.tier,
      reported: toReportedFindings(result.issues),
      costUsd: result.runCost?.estimatedCostUsd ?? 0,
      durationMs: result.runCost?.durationMs ?? wallClockMs,
      errored: result.errored === true,
    };

    if (options.runTwice) {
      const secondResult = await runPRReview(pr, selection, config, worktreePath);
      outcome.reportedSecondRun = toReportedFindings(secondResult.issues);
    }

    return outcome;
  } catch (err) {
    log.error({ err }, "Eval case run failed");
    return {
      caseId: evalCase.id,
      tier: evalCase.tier,
      reported: [],
      costUsd: 0,
      durationMs: 0,
      errored: true,
    };
  } finally {
    if (worktreePath) {
      await removeWorktree(evalCase.repoPath, worktreePath);
    }
  }
}

/*
 * Run every case in sequence, reporting progress via onProgress. Sequential
 * on purpose: each runCase call is an unbounded-cost model invocation, and
 * running the eval's cases concurrently would stack on top of the reviewer's
 * own concurrency limits rather than respect them.
 */
export async function runCases(
  cases: EvalCase[],
  options: RunCaseOptions & { onProgress?: (done: number, total: number) => void } = {}
): Promise<CaseOutcome[]> {
  const outcomes: CaseOutcome[] = [];
  for (const evalCase of cases) {
    outcomes.push(await runCase(evalCase, options));
    options.onProgress?.(outcomes.length, cases.length);
  }
  return outcomes;
}
