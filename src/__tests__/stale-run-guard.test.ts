import { describe, it, expect } from "vitest";
import { InMemoryRunFreshnessChecker } from "../orchestration/stale-runs.js";

describe("InMemoryRunFreshnessChecker", () => {
  it("treats run as current until marked superseded", () => {
    const checker = new InMemoryRunFreshnessChecker();
    const runKey = "org/repo#1@abc";
    expect(checker.isCurrentRun(runKey)).toBe(true);
    checker.markSuperseded(runKey);
    expect(checker.isCurrentRun(runKey)).toBe(false);
    checker.clearSuperseded(runKey);
    expect(checker.isCurrentRun(runKey)).toBe(true);
  });
});
