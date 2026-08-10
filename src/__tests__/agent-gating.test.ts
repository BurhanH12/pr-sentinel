import { describe, it, expect } from "vitest";
import { computeShouldFail } from "../agent/gating.js";
import { truncateIssuesToTop, truncateCheckedToTop } from "../agent/runner.js";
import type { LineComment, ReviewRulesConfig } from "../types.js";

const baseConfig: ReviewRulesConfig = {
  rules: "",
  blockOnFailure: true,
  failureThreshold: "high",
  excludePatterns: [],
  maxFilesPerRun: 40,
  focusAreas: [],
  pathRules: [],
};

function issue(
  partial: Partial<LineComment> & Pick<LineComment, "severity">
): LineComment {
  return {
    path: "a.ts",
    line: 1,
    side: "RIGHT",
    body: "issue",
    ...partial,
  };
}

describe("computeShouldFail", () => {
  it("blocks a critical issue at failureThreshold: high", () => {
    const result = computeShouldFail(
      [issue({ severity: "critical" })],
      baseConfig
    );
    expect(result.shouldFail).toBe(true);
    expect(result.gateSummary.blockEligibleCount).toBe(1);
  });

  it("treats a low issue as advisory, not blocking", () => {
    const result = computeShouldFail([issue({ severity: "low" })], baseConfig);
    expect(result.shouldFail).toBe(false);
    expect(result.gateSummary.advisoryCount).toBe(1);
  });

  it("yields shouldFail: false for an empty issue list", () => {
    const result = computeShouldFail([], baseConfig);
    expect(result.shouldFail).toBe(false);
    expect(result.gateSummary.blockEligibleCount).toBe(0);
    expect(result.gateSummary.advisoryCount).toBe(0);
  });
});

describe("truncateIssuesToTop", () => {
  it("parses an 11-issue overshoot down to exactly 10, keeping the highest severities", () => {
    const severities: LineComment["severity"][] = [
      "critical",
      "critical",
      "critical",
      "critical",
      "critical",
      "high",
      "high",
      "high",
      "medium",
      "medium",
      "low", // the one that should be dropped
    ];
    const issues = severities.map((severity, i) =>
      issue({ severity, line: i + 1 })
    );

    const result = truncateIssuesToTop(issues);

    expect(result.issues).toHaveLength(10);
    expect(result.droppedCount).toBe(1);
    expect(result.issues.some((i) => i.severity === "low")).toBe(false);
    expect(result.issues.filter((i) => i.severity === "critical")).toHaveLength(5);
  });

  it("leaves a 10-issue payload untouched", () => {
    const issues = Array.from({ length: 10 }, (_, i) =>
      issue({ severity: "medium", line: i + 1 })
    );

    const result = truncateIssuesToTop(issues);

    expect(result.issues).toEqual(issues);
    expect(result.droppedCount).toBe(0);
  });

  it("is stable within a severity band, preserving original relative order", () => {
    const issues = Array.from({ length: 11 }, (_, i) =>
      issue({ severity: "medium", line: i + 1, body: `issue-${i}` })
    );

    const result = truncateIssuesToTop(issues);

    expect(result.issues).toHaveLength(10);
    expect(result.issues.map((i) => i.body)).toEqual(
      issues.slice(0, 10).map((i) => i.body)
    );
  });
});

describe("truncateCheckedToTop", () => {
  it("truncates a 7-entry overshoot down to exactly the first 6", () => {
    const checked = Array.from({ length: 7 }, (_, i) => `checked-${i}`);

    const result = truncateCheckedToTop(checked);

    expect(result).toHaveLength(6);
    expect(result).toEqual(checked.slice(0, 6));
  });

  it("leaves a 6-entry payload untouched", () => {
    const checked = Array.from({ length: 6 }, (_, i) => `checked-${i}`);

    const result = truncateCheckedToTop(checked);

    expect(result).toEqual(checked);
  });
});
