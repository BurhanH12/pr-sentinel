import { describe, it, expect } from "vitest";
import { mergeConfig, reviewRulesConfigSchema } from "../config/loader.js";
import type { ReviewRulesConfig } from "../types.js";

const base: ReviewRulesConfig = {
  rules: "base",
  blockOnFailure: false,
  failureThreshold: "high",
  excludePatterns: [],
  maxFilesPerRun: 40,
  focusAreas: ["security"],
  pathRules: [],
};

describe("reviewRulesConfigSchema", () => {
  it("rejects a wrong-case failureThreshold and leaves ORG_DEFAULTS-derived values untouched", () => {
    const result = reviewRulesConfigSchema.safeParse({ failureThreshold: "High" });
    expect(result.success).toBe(false);

    const merged = mergeConfig(base, {});
    expect(merged.failureThreshold).toBe("high");
  });

  it("accepts a valid partial override and mergeConfig applies it", () => {
    const result = reviewRulesConfigSchema.safeParse({
      failureThreshold: "critical",
      maxFilesPerRun: 10,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const merged = mergeConfig(base, result.data);
    expect(merged.failureThreshold).toBe("critical");
    expect(merged.maxFilesPerRun).toBe(10);
  });
});

describe("mergeConfig", () => {
  it("returns the base unchanged for an empty override", () => {
    expect(mergeConfig(base, {})).toEqual(base);
  });

  it("ignores explicit undefined values in the override", () => {
    const merged = mergeConfig(base, {
      rules: undefined,
      maxFilesPerRun: undefined,
    });
    expect(merged.rules).toBe(base.rules);
    expect(merged.maxFilesPerRun).toBe(base.maxFilesPerRun);
  });

  it("merges every field automatically, including ones a hand-written merge could forget", () => {
    const fullOverride: ReviewRulesConfig = {
      rules: "override rules",
      blockOnFailure: true,
      failureThreshold: "low",
      excludePatterns: ["*.snap"],
      maxFilesPerRun: 5,
      focusAreas: ["style"],
      pathRules: [{ patterns: ["apps/**"], rules: "app rules" }],
    };

    const merged = mergeConfig(base, fullOverride);
    expect(merged).toEqual(fullOverride);
  });
});
