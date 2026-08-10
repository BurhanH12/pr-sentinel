import { describe, it, expect } from "vitest";
import { estimateCostUsd, cacheHitRate } from "../observability/cost.js";

describe("estimateCostUsd", () => {
  it("computes the hand-computed cost for a known usage object", () => {
    const cost = estimateCostUsd(
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      "composer-2.5"
    );
    // 1M input @ $1.25/MTok + 1M output @ $6/MTok = 7.25
    expect(cost).toBeCloseTo(7.25, 10);
  });

  it("charges cached reads less than the same token count uncached", () => {
    const uncached = estimateCostUsd({ inputTokens: 1000 }, "composer-2.5");
    const cached = estimateCostUsd(
      { inputTokens: 1000, cacheReadTokens: 500 },
      "composer-2.5"
    );
    expect(cached).toBeLessThan(uncached);
  });

  it("falls back to the default pricing for an unknown model without throwing", () => {
    expect(() =>
      estimateCostUsd({ inputTokens: 100, outputTokens: 100 }, "some-unknown-model")
    ).not.toThrow();
    const known = estimateCostUsd(
      { inputTokens: 100, outputTokens: 100 },
      "composer-2.5"
    );
    const unknown = estimateCostUsd(
      { inputTokens: 100, outputTokens: 100 },
      "some-unknown-model"
    );
    expect(unknown).toBe(known);
  });

  it("returns 0 for empty or absent usage", () => {
    expect(estimateCostUsd({}, "composer-2.5")).toBe(0);
  });

  it("clamps billed input tokens at 0 when cacheReadTokens exceeds inputTokens", () => {
    // Without the Math.max(0, ...) guard, billedInputTokens would go
    // negative here (100 - 500 = -400), making inputCost negative and
    // pulling the total cost below the cached-read-only cost.
    const cost = estimateCostUsd(
      { inputTokens: 100, cacheReadTokens: 500 },
      "composer-2.5"
    );
    // billedInputTokens clamps to 0, so cost is exactly the discounted
    // cache-read cost: 500 tokens @ 10% of $1.25/MTok.
    const expected = (500 * 1.25 * 0.1) / 1_000_000;
    expect(cost).toBeCloseTo(expected, 10);
    expect(cost).toBeGreaterThanOrEqual(0);
  });
});

describe("cacheHitRate", () => {
  it("returns cacheReadTokens / inputTokens", () => {
    expect(cacheHitRate({ inputTokens: 200, cacheReadTokens: 50 })).toBe(0.25);
  });

  it("returns 0 when inputTokens is 0", () => {
    expect(cacheHitRate({ inputTokens: 0, cacheReadTokens: 50 })).toBe(0);
  });

  it("returns 0 when inputTokens is absent", () => {
    expect(cacheHitRate({})).toBe(0);
  });
});
