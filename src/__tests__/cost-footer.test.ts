/**
 * Tests for cost footer formatting - verifies:
 *   - A populated runCost renders the expected string with proper formatting
 *   - An absent runCost renders nothing (empty string)
 *   - Sub-cent cost renders as $0.00 rather than scientific notation
 *   - Cache hit rate is displayed as a percentage (0-100, rounded)
 *   - Token count is thousands-separated
 *   - Duration is rendered in whole seconds
 *   - Missing token count is handled gracefully (omitted from output)
 */
import { describe, it, expect } from "vitest";
import { formatCostFooter } from "../github/comments.js";
import type { ReviewResult } from "../types.js";

describe("formatCostFooter", () => {
  it("renders a populated runCost with proper formatting", () => {
    const runCost: ReviewResult["runCost"] = {
      usage: { totalTokens: 12431, inputTokens: 8000, outputTokens: 4431 },
      estimatedCostUsd: 0.07,
      cacheHitRate: 0.68,
      durationMs: 94000,
    };

    const result = formatCostFooter(runCost);

    expect(result).toBe(
      "This review used $0.07 of compute (12,431 tokens, 68% cache hit) in 94s."
    );
  });

  it("renders nothing when runCost is absent", () => {
    const result = formatCostFooter(undefined);

    expect(result).toBe("");
  });

  it("renders sub-cent cost as $0.00 rather than scientific notation", () => {
    const runCost: ReviewResult["runCost"] = {
      usage: { totalTokens: 100 },
      estimatedCostUsd: 0.001,
      cacheHitRate: 0.5,
      durationMs: 5000,
    };

    const result = formatCostFooter(runCost);

    expect(result).toContain("$0.00");
    expect(result).not.toContain("e-");
  });

  it("rounds cache hit rate to whole percent", () => {
    const runCost: ReviewResult["runCost"] = {
      usage: { totalTokens: 1000 },
      estimatedCostUsd: 0.05,
      cacheHitRate: 0.6789,
      durationMs: 10000,
    };

    const result = formatCostFooter(runCost);

    expect(result).toContain("68% cache hit");
  });

  it("thousands-separates token count", () => {
    const runCost: ReviewResult["runCost"] = {
      usage: { totalTokens: 1234567 },
      estimatedCostUsd: 2.5,
      cacheHitRate: 0.5,
      durationMs: 60000,
    };

    const result = formatCostFooter(runCost);

    expect(result).toContain("1,234,567 tokens");
  });

  it("renders duration in whole seconds, rounding to nearest", () => {
    const runCost: ReviewResult["runCost"] = {
      usage: { totalTokens: 500 },
      estimatedCostUsd: 0.02,
      cacheHitRate: 0.3,
      durationMs: 94000,
    };

    const result = formatCostFooter(runCost);

    expect(result).toContain(" in 94s.");
  });

  it("handles missing token count gracefully by omitting the token count part", () => {
    const runCost: ReviewResult["runCost"] = {
      usage: { inputTokens: 5000, outputTokens: 2000 },
      estimatedCostUsd: 0.04,
      cacheHitRate: 0.5,
      durationMs: 30000,
    };

    const result = formatCostFooter(runCost);

    // Should render cost and duration without token count or cache hit
    expect(result).toBe("This review used $0.04 of compute in 30s.");
    expect(result).not.toContain("tokens");
    expect(result).not.toContain("cache hit");
  });

  it("zero cache hit rate renders as 0%", () => {
    const runCost: ReviewResult["runCost"] = {
      usage: { totalTokens: 5000 },
      estimatedCostUsd: 0.03,
      cacheHitRate: 0,
      durationMs: 20000,
    };

    const result = formatCostFooter(runCost);

    expect(result).toContain("0% cache hit");
  });

  it("100% cache hit rate renders as 100%", () => {
    const runCost: ReviewResult["runCost"] = {
      usage: { totalTokens: 1000 },
      estimatedCostUsd: 0.001,
      cacheHitRate: 1,
      durationMs: 5000,
    };

    const result = formatCostFooter(runCost);

    expect(result).toContain("100% cache hit");
  });
});
