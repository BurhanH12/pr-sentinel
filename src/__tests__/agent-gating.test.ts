import { describe, it, expect } from "vitest";
import { computeShouldFail } from "../agent/gating.js";
import type { LineComment, ReviewRulesConfig } from "../types.js";

const baseConfig: ReviewRulesConfig = {
  rules: "",
  blockOnFailure: true,
  failureThreshold: "high",
  minConfidenceToBlock: 0.7,
  riskThreshold: "medium",
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
    confidence: 0.9,
    risk: "high",
    ...partial,
  };
}

describe("computeShouldFail", () => {
  it("blocks when severity, risk, and confidence meet thresholds", () => {
    const result = computeShouldFail([issue({ severity: "high" })], baseConfig);
    expect(result.shouldFail).toBe(true);
    expect(result.gateSummary.blockEligibleCount).toBe(1);
  });

  it("does not block high severity with low confidence", () => {
    const result = computeShouldFail(
      [issue({ severity: "high", confidence: 0.3 })],
      baseConfig
    );
    expect(result.shouldFail).toBe(false);
    expect(result.gateSummary.advisoryCount).toBe(1);
  });

  it("does not block when severity below failureThreshold", () => {
    const result = computeShouldFail(
      [issue({ severity: "low", risk: "low" })],
      baseConfig
    );
    expect(result.shouldFail).toBe(false);
  });
});
