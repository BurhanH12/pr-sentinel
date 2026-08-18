/*
 * Pure scoring layer for the review eval (IMPROVEMENT-PLAN §2.4, §2.5, §2.6,
 * §2.11). Everything here is a function over data already produced upstream
 * by the miner, the injector and the harness - no git, no network, no model,
 * no file writing. The caller decides what to do with the string this
 * produces.
 */

import type {
  CaseOutcome,
  EvalCase,
  ExpectedFinding,
  ReportedFinding,
  ScoreReport,
  TierScore,
} from "./types.js";
import { LINE_TOLERANCE } from "./types.js";

/** Budgets from IMPROVEMENT-PLAN §2.5, reused by the report. */
const COST_MEDIAN_BUDGET_USD = 0.1;
const COST_CAP_USD = 0.5;
const LATENCY_P50_BUDGET_MS = 2 * 60 * 1000;
const LATENCY_P95_BUDGET_MS = 5 * 60 * 1000;

/** Stability floor from IMPROVEMENT-PLAN §2.11. */
const STABILITY_THRESHOLD = 0.8;

/** True when `finding` lands on the same path within `tolerance` lines of an expected line. */
export function matchesExpected(
  finding: ReportedFinding,
  expected: ExpectedFinding[],
  tolerance: number = LINE_TOLERANCE
): boolean {
  return expected.some(
    (e) =>
      e.path === finding.path &&
      e.lines.some((line) => Math.abs(line - finding.line) <= tolerance)
  );
}

/*
 * Maximum-cardinality bipartite matching via Kuhn's augmenting-path DFS.
 * `n` is a handful of findings per case, so a plain O(V*E) DFS is simpler
 * and fast enough - there is no reason to reach for anything fancier.
 *
 * Matching greedily in array order (as an earlier version of this file did)
 * is order-dependent: which expected location a finding "claims" can depend
 * on the order the caller happens to list expected locations in, which
 * nothing about the domain controls and which can swing precision/recall by
 * tens of points on data that didn't actually change. An augmenting-path
 * search finds the true maximum matching regardless of array order.
 *
 * Returns `matchLeft`, where `matchLeft[i]` is the matched right-hand index,
 * or -1 when left index `i` is unmatched.
 */
function maxBipartiteMatching(
  leftSize: number,
  rightSize: number,
  edge: (i: number, j: number) => boolean
): number[] {
  const matchRight = new Array<number>(rightSize).fill(-1);
  const matchLeft = new Array<number>(leftSize).fill(-1);

  function tryAugment(i: number, visited: boolean[]): boolean {
    for (let j = 0; j < rightSize; j++) {
      if (!edge(i, j) || visited[j]) continue;
      visited[j] = true;
      if (matchRight[j] === -1 || tryAugment(matchRight[j]!, visited)) {
        matchRight[j] = i;
        matchLeft[i] = j;
        return true;
      }
    }
    return false;
  }

  for (let i = 0; i < leftSize; i++) {
    tryAugment(i, new Array<boolean>(rightSize).fill(false));
  }

  return matchLeft;
}

/*
 * Counts one case's reported findings against its expected locations, using
 * the maximum matching between them (see maxBipartiteMatching above).
 * `matchesExpected` is the single definition of "same place" - both this
 * function and findingOverlap route their edge test through it, so there is
 * exactly one place tolerance and path equality are decided.
 *
 * A finding that matches nothing is a false positive. An expected location
 * matched by nothing is a false negative. Several findings that could all
 * reach the same expected location still only produce one true positive -
 * the matching can only pair each expected location with one finding - and
 * the rest count as false positives, same as what a human reading the PR
 * sees (one real comment, then noise on top of it).
 */
function countCase(
  expected: ExpectedFinding[],
  reported: ReportedFinding[],
  tolerance: number
): { truePositives: number; falsePositives: number; falseNegatives: number } {
  const matchLeft = maxBipartiteMatching(
    reported.length,
    expected.length,
    (i, j) => matchesExpected(reported[i]!, [expected[j]!], tolerance)
  );
  const truePositives = matchLeft.filter((j) => j !== -1).length;

  return {
    truePositives,
    falsePositives: reported.length - truePositives,
    falseNegatives: expected.length - truePositives,
  };
}

function emptyTierScore(): TierScore {
  return {
    cases: 0,
    truePositives: 0,
    falsePositives: 0,
    falseNegatives: 0,
    precision: null,
    recall: null,
  };
}

function withRates(t: TierScore): TierScore {
  const denomP = t.truePositives + t.falsePositives;
  const denomR = t.truePositives + t.falseNegatives;
  return {
    ...t,
    precision: denomP > 0 ? t.truePositives / denomP : null,
    recall: denomR > 0 ? t.truePositives / denomR : null,
  };
}

/*
 * Percentile of a value list. Sorts ascending and indexes with
 * Math.min(n - 1, Math.ceil(p * n) - 1), so p is a fraction in [0, 1]. This
 * makes the median of an even-length list the lower of the two middle
 * values rather than an interpolated average - simpler to reason about and
 * always an actual observed sample, which matters when the sample is a cost
 * or a duration someone will want to trace back to a specific case.
 */
function percentile(sortedAscending: number[], p: number): number {
  const n = sortedAscending.length;
  if (n === 0) return 0;
  const idx = Math.min(n - 1, Math.ceil(p * n) - 1);
  return sortedAscending[Math.max(0, idx)]!;
}

/*
 * Score outcomes against their cases.
 *
 * An outcome whose caseId has no matching case is a programming error (the
 * harness produced an outcome for a case it was never given) - we throw
 * rather than silently skip it, since a swallowed mismatch would quietly
 * undercount the report.
 *
 * An errored outcome means the reviewer never produced a parseable answer.
 * It is counted in erroredCases, and both its reported findings and its
 * case's expected findings are excluded from every precision/recall
 * computation - excluding only the findings would let a crashing reviewer
 * masquerade as a recall failure, and excluding only the expectations would
 * let it masquerade as perfect precision. Excluding both makes an error
 * visible as an error, not as a score.
 *
 * TierScore.cases still counts an errored case, on top of it being counted
 * in erroredCases. This is deliberate, not double counting: `cases` means
 * cases attempted, so a reviewer that crashes on half the corpus cannot
 * shrink its own denominator and hide the failure rate by making `cases`
 * only reflect the half that completed.
 */
export function scoreCases(
  cases: EvalCase[],
  outcomes: CaseOutcome[],
  now: () => string = () => new Date().toISOString()
): ScoreReport {
  const caseById = new Map(cases.map((c) => [c.id, c]));

  const overall = emptyTierScore();
  const tier1 = emptyTierScore();
  const tier2 = emptyTierScore();
  let erroredCases = 0;

  const costs: number[] = [];
  const durations: number[] = [];
  let totalUsd = 0;

  const overlaps: number[] = [];

  for (const outcome of outcomes) {
    const evalCase = caseById.get(outcome.caseId);
    if (!evalCase) {
      throw new Error(
        `scoreCases: outcome references unknown caseId "${outcome.caseId}"`
      );
    }

    const tierScore = evalCase.tier === 1 ? tier1 : tier2;

    costs.push(outcome.costUsd);
    durations.push(outcome.durationMs);
    totalUsd += outcome.costUsd;

    tierScore.cases += 1;
    overall.cases += 1;

    if (outcome.errored) {
      erroredCases += 1;
    } else {
      const counted = countCase(
        evalCase.expected,
        outcome.reported,
        LINE_TOLERANCE
      );
      tierScore.truePositives += counted.truePositives;
      tierScore.falsePositives += counted.falsePositives;
      tierScore.falseNegatives += counted.falseNegatives;
      overall.truePositives += counted.truePositives;
      overall.falsePositives += counted.falsePositives;
      overall.falseNegatives += counted.falseNegatives;
    }

    if (outcome.reportedSecondRun) {
      overlaps.push(
        findingOverlap(
          outcome.reported,
          outcome.reportedSecondRun,
          LINE_TOLERANCE
        )
      );
    }
  }

  const sortedCosts = [...costs].sort((a, b) => a - b);
  const sortedDurations = [...durations].sort((a, b) => a - b);

  const report: ScoreReport = {
    mode: "single-pass",
    generatedAt: now(),
    overall: withRates(overall),
    byTier: { tier1: withRates(tier1), tier2: withRates(tier2) },
    cost: {
      medianUsd: percentile(sortedCosts, 0.5),
      p95Usd: percentile(sortedCosts, 0.95),
      totalUsd,
    },
    latency: {
      p50Ms: percentile(sortedDurations, 0.5),
      p95Ms: percentile(sortedDurations, 0.95),
    },
    erroredCases,
  };

  if (overlaps.length > 0) {
    report.stability = {
      casesMeasured: overlaps.length,
      meanOverlap: overlaps.reduce((a, b) => a + b, 0) / overlaps.length,
    };
  }

  return report;
}

/*
 * Jaccard overlap between two runs of the same case. Findings from the two
 * runs are paired by the same maximum-bipartite-matching approach as
 * countCase (greedy, order-dependent matching had the identical defect
 * here: it could report a run as unstable purely because of array order,
 * which can flip a report from stable to a false "below the 80% threshold"
 * alarm). A run-B finding is folded into a one-off ExpectedFinding so the
 * edge test still goes through matchesExpected, the single "same place"
 * definition. Overlap is |matched| / |union|. Two silent runs (both empty)
 * agree perfectly by definition - there is nothing to disagree about - so
 * that returns 1 rather than the 0/0 a literal Jaccard formula would
 * produce.
 */
export function findingOverlap(
  runA: ReportedFinding[],
  runB: ReportedFinding[],
  tolerance: number = LINE_TOLERANCE
): number {
  if (runA.length === 0 && runB.length === 0) return 1;
  if (runA.length === 0 || runB.length === 0) return 0;

  const matchLeft = maxBipartiteMatching(runA.length, runB.length, (i, j) =>
    matchesExpected(
      runA[i]!,
      [{ path: runB[j]!.path, lines: [runB[j]!.line] }],
      tolerance
    )
  );
  const intersection = matchLeft.filter((j) => j !== -1).length;

  const union = runA.length + runB.length - intersection;
  return intersection / union;
}

// ─── Report rendering ──────────────────────────────────────────────────────

function pct(value: number | null): string {
  return value === null ? "N/A" : `${(value * 100).toFixed(1)}%`;
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function tierRow(label: string, t: TierScore): string {
  return `| ${label} | ${t.cases} | ${t.truePositives} | ${t.falsePositives} | ${t.falseNegatives} | ${pct(t.precision)} | ${pct(t.recall)} |`;
}

/*
 * The publishable artefact. Markdown, no HTML, meant to be posted or
 * committed as-is. Order matches the brief: headline numbers with mode
 * stated explicitly, the per-tier table, the stability line (flagging the
 * §2.11 80% floor when missed), the cost/latency lines against the §2.5
 * budgets, and finally a per-case table. Every budget or threshold breach is
 * called out in the text itself - this report is meant to be published
 * honestly, including when the numbers are bad.
 */
export function renderReportMarkdown(
  report: ScoreReport,
  cases: EvalCase[],
  outcomes: CaseOutcome[]
): string {
  const caseById = new Map(cases.map((c) => [c.id, c]));
  const lines: string[] = [];

  lines.push("# PR Sentinel Eval Report", "");
  lines.push(`Mode: **${report.mode}**  `);
  lines.push(`Generated: ${report.generatedAt}`, "");

  lines.push("## Headline", "");
  lines.push(`- Precision: **${pct(report.overall.precision)}**`);
  lines.push(`- Recall: **${pct(report.overall.recall)}**`);
  lines.push(`- Cases: **${report.overall.cases}**`);
  lines.push(`- Errored cases: **${report.erroredCases}**`, "");

  lines.push("## By tier", "");
  lines.push(
    "_Cases counts cases attempted, including errored ones; TP/FP/FN and the rates derived from them only cover cases that completed._",
    ""
  );
  lines.push("| Tier | Cases | TP | FP | FN | Precision | Recall |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  lines.push(tierRow("Tier 1 (history)", report.byTier.tier1));
  lines.push(tierRow("Tier 2 (injected)", report.byTier.tier2));
  lines.push(tierRow("Overall", report.overall), "");

  lines.push("## Stability (§2.11)", "");
  if (report.stability) {
    const { casesMeasured, meanOverlap } = report.stability;
    const breach = meanOverlap < STABILITY_THRESHOLD;
    const flag = breach
      ? ` **BELOW THE ${(STABILITY_THRESHOLD * 100).toFixed(0)}% THRESHOLD**`
      : "";
    lines.push(
      `Mean overlap across ${casesMeasured} case(s) run twice: **${pct(
        meanOverlap
      )}**.${flag}`
    );
  } else {
    lines.push("No case was run twice; stability was not measured.");
  }
  lines.push("");

  lines.push("## Cost and latency (§2.5)", "");
  const medianBreach = report.cost.medianUsd > COST_MEDIAN_BUDGET_USD;
  const capBreach = report.cost.p95Usd > COST_CAP_USD;
  const p50Breach = report.latency.p50Ms > LATENCY_P50_BUDGET_MS;
  const p95Breach = report.latency.p95Ms > LATENCY_P95_BUDGET_MS;
  // The hard $0.50 cap is a per-review limit, but p95Usd only ever exposes
  // the 95th-percentile run - with 20+ cases a single blown-out run can sit
  // outside that percentile and never trip a breach here. Count every
  // over-cap case explicitly so a single $5 outlier cannot hide behind an
  // aggregate that looks fine; the per-case table below names each one.
  const overCapCount = outcomes.filter(
    (o) => o.costUsd > COST_CAP_USD
  ).length;
  lines.push(
    `- Median cost: ${usd(report.cost.medianUsd)} (budget ${usd(
      COST_MEDIAN_BUDGET_USD
    )})${medianBreach ? " **OVER BUDGET**" : ""}`
  );
  lines.push(
    `- P95 cost: ${usd(report.cost.p95Usd)} (hard cap ${usd(COST_CAP_USD)})${
      capBreach ? " **OVER CAP**" : ""
    }`
  );
  lines.push(`- Total cost: ${usd(report.cost.totalUsd)}`);
  lines.push(
    `- Cases over the ${usd(COST_CAP_USD)} hard cap: **${overCapCount}**${
      overCapCount > 0 ? " **(see per-case table)**" : ""
    }`
  );
  lines.push(
    `- P50 latency: ${seconds(report.latency.p50Ms)} (budget ${seconds(
      LATENCY_P50_BUDGET_MS
    )})${p50Breach ? " **OVER BUDGET**" : ""}`
  );
  lines.push(
    `- P95 latency: ${seconds(report.latency.p95Ms)} (budget ${seconds(
      LATENCY_P95_BUDGET_MS
    )})${p95Breach ? " **OVER BUDGET**" : ""}`,
    ""
  );

  lines.push("## Per case", "");
  lines.push(
    "| Case | Tier | Expected | Reported | TP | FP | FN | Cost | Duration |"
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const outcome of outcomes) {
    const evalCase = caseById.get(outcome.caseId);
    if (!evalCase) {
      throw new Error(
        `renderReportMarkdown: outcome references unknown caseId "${outcome.caseId}"`
      );
    }
    const idCell = outcome.errored
      ? `${evalCase.id} (errored)`
      : evalCase.id;
    const counts = outcome.errored
      ? { truePositives: "-", falsePositives: "-", falseNegatives: "-" }
      : countCase(evalCase.expected, outcome.reported, LINE_TOLERANCE);
    const costCell =
      outcome.costUsd > COST_CAP_USD
        ? `${usd(outcome.costUsd)} **OVER CAP**`
        : usd(outcome.costUsd);
    lines.push(
      `| ${idCell} | ${evalCase.tier} | ${evalCase.expected.length} | ${outcome.reported.length} | ${counts.truePositives} | ${counts.falsePositives} | ${counts.falseNegatives} | ${costCell} | ${seconds(outcome.durationMs)} |`
    );
  }
  lines.push("");

  return lines.join("\n");
}
