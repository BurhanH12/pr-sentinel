import { describe, it, expect } from "vitest";
import { mergeConfig, resolveMatchingPathRules } from "../config/loader.js";
import type { ReviewRulesConfig } from "../types.js";

const base: ReviewRulesConfig = {
  rules: "base",
  blockOnFailure: false,
  failureThreshold: "high",
  minConfidenceToBlock: 0.7,
  riskThreshold: "medium",
  excludePatterns: [],
  maxFilesPerRun: 40,
  focusAreas: ["security"],
  pathRules: [],
};

describe("mergeConfig", () => {
  it("merges pathRules and gate fields from override", () => {
    const merged = mergeConfig(base, {
      pathRules: [{ patterns: ["apps/web/**"], rules: "Next rules" }],
      minConfidenceToBlock: 0.8,
    });
    expect(merged.pathRules).toHaveLength(1);
    expect(merged.minConfidenceToBlock).toBe(0.8);
  });
});

describe("resolveMatchingPathRules", () => {
  it("returns packs matching changed paths", () => {
    const config = mergeConfig(base, {
      pathRules: [
        { patterns: ["apps/api/**"], rules: "Nest" },
        { patterns: ["apps/web/**"], rules: "Next" },
      ],
    });
    const matched = resolveMatchingPathRules(config, [
      "apps/api/src/main.ts",
      "README.md",
    ]);
    expect(matched).toHaveLength(1);
    expect(matched[0]!.rules).toBe("Nest");
  });
});
