/*
 * Tier 2 case generator (IMPROVEMENT-PLAN §2.4 Tier 2).
 *
 * Ground truth by construction: take a real, known-good commit, break exactly
 * one thing in one changed file with a line-level text edit, and record
 * precisely which line was broken. This gives unlimited eval volume with
 * zero hand labelling, at the cost of the bugs being synthetic rather than
 * real (that gap is why Tier 1 history-mining exists alongside it).
 *
 * Deliberately no AST library: an operator that a regex over the raw text
 * cannot apply safely is skipped rather than forced, so what lands is always
 * a real, mechanical, explainable edit.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { simpleGit } from "simple-git";
import type { CaseProvenance, EvalCase, MutationOperator } from "./types.js";

export interface Mutation {
  operator: MutationOperator;
  /** 1-based line in the mutated file where the change landed. */
  line: number;
  /** The original and mutated text of that line, for the report. */
  before: string;
  after: string;
  /** Full mutated file contents. */
  mutatedSource: string;
}

export interface InjectOptions {
  /** Scratch directory for the mutated clone. Required - never mutate the source repo. */
  workDir: string;
  /** Stop after this many cases. Default 20. */
  maxCases?: number;
  /** Operators to try, in order. Default: all four. */
  operators?: MutationOperator[];
  /** Only consider commits newer than this. Default 365. */
  sinceDays?: number;
  /** Deterministic selection. Default 1. */
  seed?: number;
}

const DEFAULT_OPERATORS: MutationOperator[] = [
  "invert-boundary",
  "drop-null-check",
  "swap-args",
  "remove-await",
];

interface Candidate {
  lineIndex: number;
  after: string;
}

/*
 * Deterministic PRNG (mulberry32). Only source of "randomness" anywhere in
 * this file - never Math.random or Date.now - so a given (source, seed) or
 * (repoPath, seed) always produces the same case.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/*
 * Blank out comment and string-literal spans on a line, keeping the same
 * length so positions still line up with the original text. Every operator
 * below matches against this masked view, which is what keeps mutations out
 * of comments and string contents - a match against blanked-out spaces
 * simply cannot happen. Block-comment state carries across lines via `state`.
 */
function maskLine(line: string, state: { inBlock: boolean }): string {
  let masked = "";
  let i = 0;
  const n = line.length;
  while (i < n) {
    if (state.inBlock) {
      const end = line.indexOf("*/", i);
      if (end === -1) {
        masked += " ".repeat(n - i);
        i = n;
      } else {
        masked += " ".repeat(end + 2 - i);
        i = end + 2;
        state.inBlock = false;
      }
      continue;
    }
    const two = line.slice(i, i + 2);
    if (two === "//") {
      masked += " ".repeat(n - i);
      i = n;
      continue;
    }
    if (two === "/*") {
      const end = line.indexOf("*/", i + 2);
      if (end === -1) {
        masked += " ".repeat(n - i);
        i = n;
        state.inBlock = true;
      } else {
        masked += " ".repeat(end + 2 - i);
        i = end + 2;
      }
      continue;
    }
    const ch = line[i] as string;
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      let j = i + 1;
      while (j < n && line[j] !== quote) {
        if (line[j] === "\\") j++;
        j++;
      }
      j = Math.min(j + 1, n);
      masked += " ".repeat(j - i);
      i = j;
      continue;
    }
    masked += ch;
    i++;
  }
  return masked;
}

function maskLines(lines: string[]): string[] {
  const state = { inBlock: false };
  return lines.map((line) => maskLine(line, state));
}

function invertBoundaryCandidates(lines: string[], masked: string[]): Candidate[] {
  const out: Candidate[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const m = masked[i] as string;

    let idx = m.indexOf(">=");
    if (idx !== -1) {
      out.push({ lineIndex: i, after: line.slice(0, idx) + ">" + line.slice(idx + 2) });
      continue;
    }
    idx = m.indexOf("<=");
    if (idx !== -1) {
      out.push({ lineIndex: i, after: line.slice(0, idx) + "<" + line.slice(idx + 2) });
      continue;
    }
    // Whitespace on both sides, not just "not = or >" - a real comparison is
    // written `a > b`; a generic like `Array<Foo>` is written unspaced, so
    // requiring the space keeps this operator off generics entirely.
    const gt = /(?<=\s)>(?=\s)/.exec(m);
    if (gt) {
      out.push({ lineIndex: i, after: line.slice(0, gt.index) + ">=" + line.slice(gt.index + 1) });
      continue;
    }
    const lt = /(?<=\s)<(?=\s)/.exec(m);
    if (lt) {
      out.push({ lineIndex: i, after: line.slice(0, lt.index) + "<=" + line.slice(lt.index + 1) });
    }
  }
  return out;
}

// `if (!x) return ...;` guard.
const GUARD_NOT_PATTERN = /^\s*if\s*\(\s*!\s*[\w.$]+\s*\)\s*return\b[^;]*;?\s*$/;
// `if (x == null) ...;` guard.
const GUARD_NULL_PATTERN = /^\s*if\s*\(\s*[\w.$]+\s*==\s*null\s*\)[^{]*;?\s*$/;

function dropNullCheckCandidates(lines: string[], masked: string[]): Candidate[] {
  const out: Candidate[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const m = masked[i] as string;

    if (GUARD_NOT_PATTERN.test(m) || GUARD_NULL_PATTERN.test(m)) {
      // Blank the line rather than remove it, so every other line number in
      // the file (including the mutation's own) stays stable.
      out.push({ lineIndex: i, after: "" });
      continue;
    }
    const idx = m.indexOf("?.");
    if (idx !== -1) {
      out.push({ lineIndex: i, after: line.slice(0, idx) + "." + line.slice(idx + 2) });
    }
  }
  return out;
}

// ponytail: identifier/number args only, not string-literal args - masking
// blanks string contents so a quoted arg can't be recovered here. Add a
// literal-aware path if swap-args needs to cover string args too.
const CALL_ARGS_PATTERN = /([A-Za-z_$][\w$]*)\s*\(\s*([\w$.]+)\s*,\s*([\w$.]+)\s*[,)]/;

// A declaration's parameter names are arbitrary and never appear in the
// diff a reviewer sees, so swapping them produces an expected finding the
// reviewer has no way to catch - skip anything declaration-shaped: a
// `function`/`constructor` keyword on the line, or a line ending in `{`
// (covers method shorthand and arrow bodies too).
const DECLARATION_PATTERN = /\bfunction\b|\bconstructor\b/;

function isDeclarationLine(masked: string): boolean {
  return DECLARATION_PATTERN.test(masked) || masked.trimEnd().endsWith("{");
}

function swapArgsCandidates(lines: string[], masked: string[]): Candidate[] {
  const out: Candidate[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const m = masked[i] as string;
    if (isDeclarationLine(m)) continue;
    const match = CALL_ARGS_PATTERN.exec(m);
    if (!match || match.index === undefined) continue;

    const full = match[0];
    const arg1 = match[2] as string;
    const arg2 = match[3] as string;
    const start = match.index;

    const parenIdx = full.indexOf("(");
    const arg1Offset = parenIdx + 1 + full.slice(parenIdx + 1).indexOf(arg1);
    const arg1Start = start + arg1Offset;
    const arg1End = arg1Start + arg1.length;

    const afterArg1 = full.slice(arg1Offset + arg1.length);
    const arg2Offset = arg1Offset + arg1.length + afterArg1.indexOf(arg2);
    const arg2Start = start + arg2Offset;
    const arg2End = arg2Start + arg2.length;

    const after =
      line.slice(0, arg1Start) +
      arg2 +
      line.slice(arg1End, arg2Start) +
      arg1 +
      line.slice(arg2End);
    out.push({ lineIndex: i, after });
  }
  return out;
}

const AWAIT_PATTERN = /\bawait\s+/;

function removeAwaitCandidates(lines: string[], masked: string[]): Candidate[] {
  const out: Candidate[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const m = masked[i] as string;
    const match = AWAIT_PATTERN.exec(m);
    if (!match || match.index === undefined) continue;
    const start = match.index;
    const end = start + match[0].length;
    out.push({ lineIndex: i, after: line.slice(0, start) + line.slice(end) });
  }
  return out;
}

function findCandidates(
  operator: MutationOperator,
  lines: string[],
  masked: string[]
): Candidate[] {
  switch (operator) {
    case "invert-boundary":
      return invertBoundaryCandidates(lines, masked);
    case "drop-null-check":
      return dropNullCheckCandidates(lines, masked);
    case "swap-args":
      return swapArgsCandidates(lines, masked);
    case "remove-await":
      return removeAwaitCandidates(lines, masked);
  }
}

/*
 * Apply the first applicable operator to `source`, trying `operators` in
 * order. Comment/string-literal spans are masked out first (see maskLine)
 * so a match can never land inside either. When an operator's pattern shows
 * up on more than one line, `seed` picks which occurrence via a seeded PRNG,
 * so the same (source, operators, seed) always yields the same mutation.
 */
export function mutateSource(
  source: string,
  operators: MutationOperator[] = DEFAULT_OPERATORS,
  seed = 1
): Mutation | null {
  const lines = source.split("\n");
  const masked = maskLines(lines);

  for (const operator of operators) {
    const candidates = findCandidates(operator, lines, masked);
    if (candidates.length === 0) continue;

    const rng = mulberry32(seed);
    const pick = candidates[Math.floor(rng() * candidates.length)] as Candidate;
    const mutatedLines = lines.slice();
    mutatedLines[pick.lineIndex] = pick.after;

    return {
      operator,
      line: pick.lineIndex + 1,
      before: lines[pick.lineIndex] as string,
      after: pick.after,
      mutatedSource: mutatedLines.join("\n"),
    };
  }
  return null;
}

function isReviewableSourceFile(path: string): boolean {
  if (!/\.(ts|tsx|js|jsx)$/.test(path)) return false;
  if (/\.test\.[jt]sx?$/.test(path)) return false;
  if (/(^|\/)__tests__\//.test(path)) return false;
  return true;
}

/*
 * Walk recent history of a local clone, breaking one line in one file per
 * commit, and return one EvalCase per successful mutation.
 *
 * The clone happens once (local, no network - simple-git against a
 * filesystem path never touches the network) and every commit is mutated on
 * top of a detached checkout of that same clone, so the source repo at
 * `repoPath` is never written to and every case's baseSha/headSha live in
 * one shared repo, exactly as EvalCase.repoPath requires.
 */
export async function injectCases(
  repoPath: string,
  options: InjectOptions
): Promise<EvalCase[]> {
  const {
    workDir,
    maxCases = 20,
    operators = DEFAULT_OPERATORS,
    sinceDays = 365,
    seed = 1,
  } = options;

  await mkdir(workDir, { recursive: true });
  const clonePath = resolve(join(workDir, "clone"));
  await rm(clonePath, { recursive: true, force: true });
  await simpleGit().clone(resolve(repoPath), clonePath);

  const git = simpleGit(clonePath);
  await git.addConfig("user.email", "eval@pr-sentinel.local");
  await git.addConfig("user.name", "pr-sentinel-eval");

  const logOutput = await git.raw([
    "log",
    "--no-merges",
    `--since=${sinceDays} days ago`,
    "--pretty=format:%H%x1f%s",
  ]);
  const commits = logOutput
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sha, subject] = line.split("\x1f");
      return { sha: sha as string, subject: subject ?? "" };
    });

  const cases: EvalCase[] = [];

  for (const commit of commits) {
    if (cases.length >= maxCases) break;

    const filesRaw = await git.raw([
      "show",
      "--name-only",
      "--pretty=format:",
      commit.sha,
    ]);
    const files = filesRaw
      .split("\n")
      .map((f) => f.trim())
      .filter((f) => f.length > 0 && isReviewableSourceFile(f));

    for (const file of files) {
      let content: string;
      try {
        content = await git.show([`${commit.sha}:${file}`]);
      } catch {
        continue;
      }

      const mutation = mutateSource(content, operators, seed);
      if (!mutation) continue;

      await git.checkout([commit.sha]);
      await writeFile(join(clonePath, file), mutation.mutatedSource, "utf-8");
      await git.add([file]);

      const shortSha = commit.sha.slice(0, 7);
      const subject = `synthetic: ${mutation.operator} in ${file}`;
      await git.commit(subject, [file]);
      const headSha = (await git.revparse(["HEAD"])).trim();

      const provenance: CaseProvenance = {
        kind: "injected",
        operator: mutation.operator,
        sourceSha: commit.sha,
      };

      cases.push({
        id: `t2-${mutation.operator}-${shortSha}`,
        tier: 2,
        repoPath: clonePath,
        headSha,
        baseSha: commit.sha,
        title: subject,
        expected: [{ path: file, lines: [mutation.line] }],
        provenance,
      });
      break;
    }
  }

  return cases;
}
