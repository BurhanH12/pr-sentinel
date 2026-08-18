import { describe, expect, it } from "vitest";
import {
  findingOverlap,
  matchesExpected,
  renderReportMarkdown,
  scoreCases,
} from "../eval/score.js";
import type {
  CaseOutcome,
  EvalCase,
  ExpectedFinding,
  ReportedFinding,
} from "../eval/types.js";

function finding(line: number, path = "a.ts"): ReportedFinding {
  return { path, line, severity: "high" };
}

function expected(lines: number[], path = "a.ts"): ExpectedFinding {
  return { path, lines };
}

function baseCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: "case-1",
    tier: 1,
    repoPath: "/tmp/repo",
    headSha: "head",
    baseSha: "base",
    title: "fix bug",
    expected: [expected([10])],
    provenance: { kind: "history", fixSha: "fix", fixSubject: "fix bug" },
    ...overrides,
  };
}

function baseOutcome(overrides: Partial<CaseOutcome> = {}): CaseOutcome {
  return {
    caseId: "case-1",
    tier: 1,
    reported: [],
    costUsd: 0.01,
    durationMs: 1000,
    errored: false,
    ...overrides,
  };
}

describe("matchesExpected", () => {
  it("matches a finding 3 lines off", () => {
    expect(matchesExpected(finding(13), [expected([10])])).toBe(true);
  });

  it("does not match a finding 4 lines off", () => {
    expect(matchesExpected(finding(14), [expected([10])])).toBe(false);
  });

  it("respects a custom tolerance", () => {
    expect(matchesExpected(finding(15), [expected([10])], 5)).toBe(true);
    expect(matchesExpected(finding(16), [expected([10])], 5)).toBe(false);
  });

  it("requires the same path", () => {
    expect(matchesExpected(finding(10, "b.ts"), [expected([10], "a.ts")])).toBe(
      false
    );
  });
});

describe("scoreCases matching", () => {
  // expected = [11, 9], reported = [10, 12] (LINE_TOLERANCE = 3, so every
  // finding reaches every expected location). Greedy first-fit matching
  // (the old implementation) walks findings in report order and lets each
  // one claim the first expected location it reaches: finding 10 claims
  // index 0 (line 11), then finding 12 also reaches index 0 first, finds it
  // claimed, and is counted a false positive without ever trying index 1
  // (line 9) - giving TP=1/FP=1/FN=1. The correct maximum matching pairs
  // both findings with a distinct expected location: TP=2/FP=0/FN=0.
  it("finds the optimal assignment rather than a greedy one", () => {
    const cases = [baseCase({ expected: [expected([11]), expected([9])] })];
    const outcomes = [baseOutcome({ reported: [finding(10), finding(12)] })];
    const report = scoreCases(cases, outcomes);
    expect(report.overall.truePositives).toBe(2);
    expect(report.overall.falsePositives).toBe(0);
    expect(report.overall.falseNegatives).toBe(0);
  });

  it("is invariant under reversing the expected array order", () => {
    const cases = [baseCase({ expected: [expected([9]), expected([11])] })];
    const outcomes = [baseOutcome({ reported: [finding(10), finding(12)] })];
    const report = scoreCases(cases, outcomes);
    expect(report.overall.truePositives).toBe(2);
    expect(report.overall.falsePositives).toBe(0);
    expect(report.overall.falseNegatives).toBe(0);
  });
});

describe("scoreCases", () => {
  it("counts two findings on the same expected line as 1 TP and 1 FP", () => {
    const cases = [baseCase({ expected: [expected([10])] })];
    const outcomes = [
      baseOutcome({ reported: [finding(10), finding(11)] }),
    ];
    const report = scoreCases(cases, outcomes);
    expect(report.overall.truePositives).toBe(1);
    expect(report.overall.falsePositives).toBe(1);
    expect(report.overall.falseNegatives).toBe(0);
  });

  it("precision is null when nothing was reported", () => {
    const cases = [baseCase({ expected: [expected([10])] })];
    const outcomes = [baseOutcome({ reported: [] })];
    const report = scoreCases(cases, outcomes);
    expect(report.overall.precision).toBeNull();
    expect(report.overall.recall).toBe(0);
  });

  it("recall is null when nothing was expected", () => {
    const cases = [baseCase({ expected: [] })];
    const outcomes = [baseOutcome({ reported: [finding(10)] })];
    const report = scoreCases(cases, outcomes);
    expect(report.overall.recall).toBeNull();
    expect(report.overall.precision).toBe(0);
  });

  it("both precision and recall are null when both sides are empty", () => {
    const cases = [baseCase({ expected: [] })];
    const outcomes = [baseOutcome({ reported: [] })];
    const report = scoreCases(cases, outcomes);
    expect(report.overall.precision).toBeNull();
    expect(report.overall.recall).toBeNull();
  });

  it("excludes an errored outcome's findings and expectations from the counts, and increments erroredCases", () => {
    const cases = [
      baseCase({ id: "ok", expected: [expected([10])] }),
      baseCase({ id: "bad", expected: [expected([20])] }),
    ];
    const outcomes = [
      baseOutcome({ caseId: "ok", reported: [finding(10)] }),
      baseOutcome({
        caseId: "bad",
        reported: [finding(99)],
        errored: true,
      }),
    ];
    const report = scoreCases(cases, outcomes);
    expect(report.erroredCases).toBe(1);
    expect(report.overall.truePositives).toBe(1);
    expect(report.overall.falsePositives).toBe(0);
    expect(report.overall.falseNegatives).toBe(0);
    // the errored case still counts toward the case totals
    expect(report.overall.cases).toBe(2);
  });

  it("throws when an outcome references an unknown case", () => {
    const cases = [baseCase()];
    const outcomes = [baseOutcome({ caseId: "missing" })];
    expect(() => scoreCases(cases, outcomes)).toThrow();
  });

  it("splits scores by tier", () => {
    const cases = [
      baseCase({ id: "t1", tier: 1, expected: [expected([10])] }),
      baseCase({ id: "t2", tier: 2, expected: [expected([20])] }),
    ];
    const outcomes = [
      baseOutcome({ caseId: "t1", tier: 1, reported: [finding(10)] }),
      baseOutcome({ caseId: "t2", tier: 2, reported: [] }),
    ];
    const report = scoreCases(cases, outcomes);
    expect(report.byTier.tier1.truePositives).toBe(1);
    expect(report.byTier.tier2.falseNegatives).toBe(1);
  });

  it("computes stability only from outcomes carrying a second run", () => {
    const cases = [
      baseCase({ id: "a", expected: [expected([10])] }),
      baseCase({ id: "b", expected: [expected([10])] }),
    ];
    const outcomes = [
      baseOutcome({
        caseId: "a",
        reported: [finding(10)],
        reportedSecondRun: [finding(10)],
      }),
      baseOutcome({ caseId: "b", reported: [finding(10)] }),
    ];
    const report = scoreCases(cases, outcomes);
    expect(report.stability).toEqual({ casesMeasured: 1, meanOverlap: 1 });
  });

  it("omits stability when no outcome carries a second run", () => {
    const cases = [baseCase()];
    const outcomes = [baseOutcome({ reported: [finding(10)] })];
    const report = scoreCases(cases, outcomes);
    expect(report.stability).toBeUndefined();
  });

  it("accepts an injected clock for generatedAt", () => {
    const cases = [baseCase()];
    const outcomes = [baseOutcome()];
    const report = scoreCases(cases, outcomes, () => "2026-01-01T00:00:00.000Z");
    expect(report.generatedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("computes cost and latency percentiles", () => {
    const cases = [
      baseCase({ id: "a" }),
      baseCase({ id: "b" }),
      baseCase({ id: "c" }),
      baseCase({ id: "d" }),
    ];
    const outcomes = [
      baseOutcome({ caseId: "a", costUsd: 0.1, durationMs: 1000 }),
      baseOutcome({ caseId: "b", costUsd: 0.2, durationMs: 2000 }),
      baseOutcome({ caseId: "c", costUsd: 0.3, durationMs: 3000 }),
      baseOutcome({ caseId: "d", costUsd: 0.4, durationMs: 4000 }),
    ];
    const report = scoreCases(cases, outcomes);
    // even-length list -> median is the lower middle value
    expect(report.cost.medianUsd).toBeCloseTo(0.2);
    expect(report.cost.totalUsd).toBeCloseTo(1.0);
    expect(report.latency.p50Ms).toBe(2000);
  });
});

describe("findingOverlap", () => {
  it("returns 1 for identical runs", () => {
    expect(findingOverlap([finding(10), finding(20)], [finding(10), finding(20)])).toBe(
      1
    );
  });

  it("returns 0 for disjoint runs", () => {
    expect(findingOverlap([finding(10)], [finding(100)])).toBe(0);
  });

  it("returns 1 when both runs are empty", () => {
    expect(findingOverlap([], [])).toBe(1);
  });

  it("returns 0 when exactly one run is empty", () => {
    expect(findingOverlap([finding(10)], [])).toBe(0);
    expect(findingOverlap([], [finding(10)])).toBe(0);
  });

  it("returns the exact Jaccard value for a half-overlapping pair", () => {
    // A = {10, 20}, B = {20, 30}; intersection = {20}, union size 3
    const overlap = findingOverlap(
      [finding(10), finding(20)],
      [finding(20), finding(30)]
    );
    expect(overlap).toBeCloseTo(1 / 3);
  });

  it("finds the optimal assignment rather than a greedy one", () => {
    // runA = [10, 12], runB = [11, 9], tolerance 2. Every finding in A
    // reaches every finding in B (all diffs <= 2), so the maximum matching
    // pairs both - overlap 1.0. A greedy left-to-right match would let
    // runA[0]=10 claim runB[0]=11 first, leaving runA[1]=12 unable to reach
    // runB[1]=9 (diff 3 > 2) and reporting overlap 1/3 instead.
    const overlap = findingOverlap(
      [finding(10), finding(12)],
      [finding(11), finding(9)],
      2
    );
    expect(overlap).toBe(1);
  });
});

describe("renderReportMarkdown", () => {
  it("contains the precision figure and flags a stability value below 0.8", () => {
    const cases = [
      baseCase({ id: "a", expected: [expected([10])] }),
      baseCase({ id: "b", expected: [expected([10])] }),
    ];
    const outcomes = [
      baseOutcome({
        caseId: "a",
        reported: [finding(10)],
        reportedSecondRun: [],
      }),
      baseOutcome({ caseId: "b", reported: [finding(10)] }),
    ];
    const report = scoreCases(cases, outcomes);
    const markdown = renderReportMarkdown(report, cases, outcomes);

    expect(markdown).toContain(`${(report.overall.precision! * 100).toFixed(1)}%`);
    expect(markdown).toContain("BELOW THE 80% THRESHOLD");
  });

  it("does not flag stability when it is at or above 0.8", () => {
    const cases = [baseCase({ id: "a", expected: [expected([10])] })];
    const outcomes = [
      baseOutcome({
        caseId: "a",
        reported: [finding(10)],
        reportedSecondRun: [finding(10)],
      }),
    ];
    const report = scoreCases(cases, outcomes);
    const markdown = renderReportMarkdown(report, cases, outcomes);
    expect(markdown).not.toContain("BELOW THE 80% THRESHOLD");
  });

  it("flags a cost budget breach", () => {
    const cases = [baseCase({ id: "a", expected: [] })];
    const outcomes = [baseOutcome({ caseId: "a", costUsd: 0.75 })];
    const report = scoreCases(cases, outcomes);
    const markdown = renderReportMarkdown(report, cases, outcomes);
    expect(markdown).toContain("OVER CAP");
  });

  it("marks an individual over-cap case in the per-case table, not just p95", () => {
    // 21 cheap cases plus one $5 outlier: p95 of 21 samples sits on a cheap
    // case, so the aggregate p95 line alone would never show the outlier.
    const cheapCases = Array.from({ length: 21 }, (_, i) =>
      baseCase({ id: `cheap-${i}`, expected: [] })
    );
    const cases = [...cheapCases, baseCase({ id: "expensive", expected: [] })];
    const cheapOutcomes = cheapCases.map((c) =>
      baseOutcome({ caseId: c.id, costUsd: 0.05 })
    );
    const outcomes = [
      ...cheapOutcomes,
      baseOutcome({ caseId: "expensive", costUsd: 5 }),
    ];
    const report = scoreCases(cases, outcomes);

    expect(report.cost.p95Usd).toBeLessThan(0.5);

    const markdown = renderReportMarkdown(report, cases, outcomes);
    expect(markdown).toContain("Cases over the $0.50 hard cap: **1**");
    expect(markdown).toMatch(/\| expensive \|.*\$5\.00 \*\*OVER CAP\*\*/);
  });

  it("notes in the by-tier section that Cases counts attempts, not scored cases", () => {
    const cases = [baseCase({ id: "a", expected: [expected([10])] })];
    const outcomes = [baseOutcome({ caseId: "a", reported: [finding(10)] })];
    const report = scoreCases(cases, outcomes);
    const markdown = renderReportMarkdown(report, cases, outcomes);
    expect(markdown).toContain("cases attempted");
  });

  it("marks an errored case in the per-case table", () => {
    const cases = [baseCase({ id: "a", expected: [expected([10])] })];
    const outcomes = [
      baseOutcome({ caseId: "a", reported: [], errored: true }),
    ];
    const report = scoreCases(cases, outcomes);
    const markdown = renderReportMarkdown(report, cases, outcomes);
    expect(markdown).toContain("a (errored)");
  });
});
