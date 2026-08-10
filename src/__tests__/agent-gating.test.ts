import { describe, it, expect } from "vitest";
import { computeShouldFail } from "../agent/gating.js";
import { agentOutputSchema } from "../agent/runner.js";
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

describe("agentOutputSchema issues cap", () => {
  it("rejects an issues array of length 11", () => {
    const elevenIssues = Array.from({ length: 11 }, (_, i) => ({
      path: "a.ts",
      line: i + 1,
      severity: "low",
      body: "issue",
    }));

    const result = agentOutputSchema.safeParse({
      verdict: "comment",
      summary: "summary",
      issues: elevenIssues,
    });

    expect(result.success).toBe(false);
  });
});
