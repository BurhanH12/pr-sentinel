/*
 * Shared contract for the review eval (IMPROVEMENT-PLAN §2.4, §6 Phase 1
 * item 7).
 *
 * The eval answers one question: when a real bug is at a known line, does the
 * reviewer put a comment there, and how much noise does it emit alongside?
 *
 * Two case sources, neither of which needs hand labelling:
 *   • Tier 1 - git-history mining. A commit that fixed a bug points at the
 *     commit that introduced it; the introducing commit is the case and the
 *     fixed lines are the ground truth.
 *   • Tier 2 - synthetic injection. Mutate a known-good commit and record
 *     exactly which line was broken.
 *
 * Everything here is data-only so the miner, the injector, the scorer and the
 * harness can be built and tested independently.
 */

import type { Severity } from "../types.js";

/** Mutation operators used by Tier 2 injection. */
export type MutationOperator =
  | "invert-boundary"
  | "drop-null-check"
  | "swap-args"
  | "remove-await";

/** A location where a bug is known to exist, in the reviewed (head) revision. */
export interface ExpectedFinding {
  /** Repo-relative path, as it appears in the diff. */
  path: string;
  /** 1-based line numbers in the head revision of `path`. */
  lines: number[];
}

/**
 * Where a case came from. Kept on the case so the report can break results
 * down by tier and so a surprising result can be traced back to real commits.
 */
export type CaseProvenance =
  | { kind: "history"; fixSha: string; fixSubject: string }
  | { kind: "injected"; operator: MutationOperator; sourceSha: string };

/** One automatically-labelled evaluation case. */
export interface EvalCase {
  /** Stable, human-readable identifier, unique within a case file. */
  id: string;
  tier: 1 | 2;
  /**
   * Absolute path to a local git repository containing both `baseSha` and
   * `headSha`. Tier 2 cases point at a scratch clone, never the source repo.
   */
  repoPath: string;
  /** Revision under review - the state that contains the bug. */
  headSha: string;
  /** Revision the diff is taken against; normally `headSha`'s first parent. */
  baseSha: string;
  /** Commit subject of `headSha`, used as the synthetic PR title. */
  title: string;
  /** Ground truth. A case with no expected findings is not a valid case. */
  expected: ExpectedFinding[];
  provenance: CaseProvenance;
}

/** A single finding as reported by the reviewer, reduced to what scoring needs. */
export interface ReportedFinding {
  path: string;
  line: number;
  severity: Severity;
}

/** What one reviewed case produced. One entry per run of the same case. */
export interface CaseOutcome {
  caseId: string;
  tier: 1 | 2;
  /** Findings from the scored (first) run. */
  reported: ReportedFinding[];
  /**
   * Findings from a second run of the identical case, when the run-twice
   * stability measure is enabled (§2.11). Never scored for precision - it
   * exists only to measure overlap with `reported`.
   */
  reportedSecondRun?: ReportedFinding[];
  /** Estimated USD cost of the scored run; 0 when the SDK reported no usage. */
  costUsd: number;
  durationMs: number;
  /** True when the reviewer never produced a parseable answer for this case. */
  errored: boolean;
}

export interface TierScore {
  cases: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  /** truePositives / (truePositives + falsePositives); null when nothing was reported. */
  precision: number | null;
  /** truePositives / (truePositives + falseNegatives); null when nothing was expected. */
  recall: number | null;
}

/**
 * The eval's output. `mode` is deliberately explicit: §5.8 requires
 * single-pass and panel numbers to be reported separately rather than merged,
 * so the panel work in Phase 3 adds a mode rather than changing these fields.
 */
export interface ScoreReport {
  mode: "single-pass" | "panel";
  generatedAt: string;
  overall: TierScore;
  byTier: { tier1: TierScore; tier2: TierScore };
  /** Absent when no case was run twice. */
  stability?: {
    casesMeasured: number;
    /** Mean Jaccard overlap of findings across the two runs, 0-1. */
    meanOverlap: number;
  };
  cost: { medianUsd: number; p95Usd: number; totalUsd: number };
  latency: { p50Ms: number; p95Ms: number };
  erroredCases: number;
}

/**
 * A reported finding counts as a hit when it lands on the same file within
 * this many lines of an expected line. Matches the tolerance the inline
 * comment dedup uses, so the eval scores what a reviewer would perceive as
 * "the same place".
 */
export const LINE_TOLERANCE = 3;
