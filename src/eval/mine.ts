/*
 * Tier 1 case miner (IMPROVEMENT-PLAN §2.4, §6 Phase 1 item 7).
 *
 * Ground truth for real-bug detection is expensive to hand-label, so this
 * mines it out of history instead: a commit whose subject reads like a fix
 * is evidence that some earlier commit shipped a bug. `git blame` on the
 * fix's parent finds which commit last touched the lines the fix changed -
 * that commit becomes the head of an EvalCase, and the touched lines become
 * the expected findings. No human ever labels anything.
 */

import { resolve } from "node:path";
import { simpleGit } from "simple-git";
import type { EvalCase, ExpectedFinding } from "./types.js";

export interface MineOptions {
  /** Stop after this many accepted cases. Default 25. */
  maxCases?: number;
  /** Only consider fix commits newer than this. Default 365. */
  sinceDays?: number;
  /** Max days between the introducing commit and its fix. Default 30. */
  fixWindowDays?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/*
 * Word-boundary match so "prefix"/"suffix" don't false-positive on "fix",
 * and a plain `Revert "..."` subject matches via the "revert" word itself -
 * no separate revert-pattern check is needed.
 */
const FIX_WORD_RE =
  /\b(fix|fixes|hotfix|bugfix|patch|regression|revert)\b/i;

const REVIEWABLE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/*
 * A commit subject looks like a bug fix: used both to pick fix candidates
 * from history and, indirectly, to explain why a case exists (its
 * provenance carries the fix subject).
 */
export function isFixSubject(subject: string): boolean {
  return FIX_WORD_RE.test(subject);
}

function stripDiffPathPrefix(path: string): string {
  return path.replace(/^[ab]\//, "");
}

/*
 * Old-side (pre-image) line ranges removed or replaced by a unified diff,
 * per path. Walks each hunk tracking the old-file line cursor: a run of
 * consecutive "-" lines is one range, "+" lines don't move the cursor, and
 * any context line (or the boundary between hunks/files) closes the run.
 * Deliberately diff-generator agnostic (context lines are tolerated even
 * though the miner calls `git diff -U0`, which never emits them) so this
 * stays testable against hand-written diff text.
 */
export function parseRemovedLineRanges(
  diff: string
): { path: string; start: number; end: number }[] {
  const ranges: { path: string; start: number; end: number }[] = [];
  let currentPath: string | null = null;
  let oldLine = 0;
  let runStart: number | null = null;
  let runEnd: number | null = null;

  const flush = (): void => {
    if (currentPath !== null && runStart !== null && runEnd !== null) {
      ranges.push({ path: currentPath, start: runStart, end: runEnd });
    }
    runStart = null;
    runEnd = null;
  };

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git")) {
      flush();
      currentPath = null;
      continue;
    }
    if (line.startsWith("--- ")) {
      flush();
      const raw = line.slice(4).trim().split("\t")[0] ?? "";
      currentPath = raw === "/dev/null" ? null : stripDiffPathPrefix(raw);
      continue;
    }
    if (line.startsWith("+++ ")) {
      continue; // new-side path; old-side ranges are keyed off "--- "
    }
    if (line.startsWith("@@")) {
      flush();
      const m = /^@@ -(\d+)(?:,\d+)? \+/.exec(line);
      if (m?.[1]) oldLine = parseInt(m[1], 10);
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      if (currentPath !== null) {
        if (runStart === null) runStart = oldLine;
        runEnd = oldLine;
      }
      oldLine++;
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      continue; // new-side line; doesn't consume an old line number
    }
    if (line.startsWith(" ")) {
      flush();
      oldLine++;
      continue;
    }
    flush(); // hunk/file trailer noise, e.g. "\ No newline at end of file"
  }
  flush();

  return ranges;
}

/*
 * Parse `git blame --porcelain` output into { sha, originalLine } entries,
 * one per blamed line. Every blamed line starts with a header of the form
 * "<40-hex-sha> <origLine> <finalLine> [<numLines>]"; metadata lines
 * (author, summary, ...) and the tab-prefixed content line never match that
 * shape, so a per-line regex is enough - no stateful parsing required.
 */
export function parseBlamePorcelain(
  output: string
): { sha: string; originalLine: number }[] {
  const entries: { sha: string; originalLine: number }[] = [];
  const headerRe = /^([0-9a-f]{40}) (\d+) (\d+)(?: \d+)?$/;
  for (const line of output.split("\n")) {
    const m = headerRe.exec(line);
    if (m?.[1] && m[2]) {
      entries.push({ sha: m[1], originalLine: parseInt(m[2], 10) });
    }
  }
  return entries;
}

interface FixCandidate {
  sha: string;
  date: Date;
  subject: string;
}

interface CommitInfo {
  parents: string[];
  date: Date;
  subject: string;
}

async function getParents(
  git: ReturnType<typeof simpleGit>,
  sha: string
): Promise<string[]> {
  const out = await git.raw(["rev-list", "--parents", "-n", "1", sha]);
  return out.trim().split(/\s+/).slice(1);
}

async function getCommitInfo(
  git: ReturnType<typeof simpleGit>,
  sha: string
): Promise<CommitInfo> {
  const out = await git.raw(["show", "-s", "--format=%P%x1f%cI%x1f%s", sha]);
  const [parents, dateStr, ...rest] = out.trim().split("\x1f");
  return {
    parents: (parents ?? "").split(/\s+/).filter(Boolean),
    date: new Date(dateStr ?? ""),
    subject: rest.join("\x1f"),
  };
}

/*
 * Walk history for commits that fixed a bug shortly after it was
 * introduced and turn each into a labelled EvalCase. See the file header
 * for the shape of the argument; the five-step algorithm (find fix
 * candidates, diff each against its parent, blame the removed lines,
 * pick the dominant introducing commit, validate and emit) is documented
 * step by step below because each step is a place a real repo's history
 * can disagree with the happy path.
 */
export async function mineHistoryCases(
  repoPath: string,
  options: MineOptions = {}
): Promise<EvalCase[]> {
  const maxCases = options.maxCases ?? 25;
  const sinceDays = options.sinceDays ?? 365;
  const fixWindowDays = options.fixWindowDays ?? 30;

  const absRepoPath = resolve(repoPath);
  const git = simpleGit({ baseDir: absRepoPath });

  try {
    await git.raw(["rev-parse", "--is-inside-work-tree"]);
  } catch (err) {
    throw new Error(
      `mineHistoryCases: ${repoPath} is not a git repository (${String(err)})`
    );
  }

  const sinceIso = new Date(Date.now() - sinceDays * DAY_MS).toISOString();
  const log = await git.raw([
    "log",
    "--no-merges",
    "--reverse",
    `--since=${sinceIso}`,
    "--pretty=format:%H%x1f%cI%x1f%s",
  ]);

  if (!log.trim()) return [];

  const candidates: FixCandidate[] = log
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sha, dateStr, ...rest] = line.split("\x1f");
      return {
        sha: sha ?? "",
        date: new Date(dateStr ?? ""),
        subject: rest.join("\x1f"),
      };
    })
    .filter((c) => isFixSubject(c.subject));

  const cases: EvalCase[] = [];
  const seenHeads = new Set<string>();

  for (const fix of candidates) {
    if (cases.length >= maxCases) break;

    const fixParents = await getParents(git, fix.sha).catch(() => null);
    if (!fixParents || fixParents.length !== 1) continue; // root or already-excluded merge
    const fixParent = fixParents[0]!;

    let diff: string;
    try {
      diff = await git.raw(["diff", "-U0", fixParent, fix.sha]);
    } catch {
      continue;
    }

    const ranges = parseRemovedLineRanges(diff).filter((r) =>
      REVIEWABLE_EXT_RE.test(r.path)
    );
    if (ranges.length === 0) continue;

    // sha -> path -> blamed original line numbers
    const bySha = new Map<string, Map<string, Set<number>>>();
    for (const range of ranges) {
      let blameOut: string;
      try {
        blameOut = await git.raw([
          "blame",
          "--porcelain",
          "-L",
          `${range.start},${range.end}`,
          fixParent,
          "--",
          range.path,
        ]);
      } catch {
        continue; // path/range not resolvable at fixParent (e.g. it was added by fix itself)
      }
      for (const entry of parseBlamePorcelain(blameOut)) {
        let byPath = bySha.get(entry.sha);
        if (!byPath) {
          byPath = new Map();
          bySha.set(entry.sha, byPath);
        }
        let lines = byPath.get(range.path);
        if (!lines) {
          lines = new Set();
          byPath.set(range.path, lines);
        }
        lines.add(entry.originalLine);
      }
    }
    if (bySha.size === 0) continue;

    // Dominant introducing commit: the sha covering the most blamed lines.
    // Ties broken by sha for determinism.
    let introducingSha: string | null = null;
    let introducingCount = -1;
    for (const [sha, byPath] of bySha) {
      let count = 0;
      for (const lines of byPath.values()) count += lines.size;
      if (
        count > introducingCount ||
        (count === introducingCount &&
          (introducingSha === null || sha < introducingSha))
      ) {
        introducingCount = count;
        introducingSha = sha;
      }
    }
    if (!introducingSha) continue;
    if (introducingSha === fix.sha) continue;
    if (seenHeads.has(introducingSha)) continue; // dedupe: earliest fix wins (candidates run oldest-first)

    const introInfo = await getCommitInfo(git, introducingSha).catch(
      () => null
    );
    if (!introInfo) continue;
    if (introInfo.parents.length !== 1) continue; // merge commit, or root (no baseSha)
    const introParent = introInfo.parents[0]!;

    // Directional: F's provenance claims F fixed I, which only holds if F
    // postdates I. Committer dates aren't guaranteed monotonic (squash
    // merges, cherry-picked backports, rebases), so a negative delta is
    // reachable and must be rejected, not just a large abs() delta.
    const diffDays =
      (fix.date.getTime() - introInfo.date.getTime()) / DAY_MS;
    if (diffDays < 0 || diffDays > fixWindowDays) continue;

    let touchedPaths: Set<string>;
    try {
      const names = await git.raw([
        "diff",
        "--name-only",
        introParent,
        introducingSha,
      ]);
      touchedPaths = new Set(names.split("\n").filter(Boolean));
    } catch {
      continue;
    }

    // Per-path pruning, not whole-case rejection: blame can legitimately
    // walk past the introducing change for one touched path while still
    // correctly attributing another path in the same fix to I, so drop
    // only the untouched path rather than discarding the whole case.
    const expected: ExpectedFinding[] = [];
    for (const [path, lines] of bySha.get(introducingSha)!) {
      if (!touchedPaths.has(path)) continue; // blame walked past the introducing change
      if (lines.size === 0) continue;
      expected.push({ path, lines: [...lines].sort((a, b) => a - b) });
    }
    if (expected.length === 0) continue;

    cases.push({
      id: `t1-${introducingSha.slice(0, 7)}-${fix.sha.slice(0, 7)}`,
      tier: 1,
      repoPath: absRepoPath,
      headSha: introducingSha,
      baseSha: introParent,
      title: introInfo.subject,
      expected,
      provenance: {
        kind: "history",
        fixSha: fix.sha,
        fixSubject: fix.subject,
      },
    });
    seenHeads.add(introducingSha);
  }

  return cases;
}
