import { describe, it, expect } from "vitest";
import { percentileForTest } from "../observability/metrics.js";

describe("percentile", () => {
  it("computes p50 and p95 from sorted samples", () => {
    const sorted = [10, 20, 30, 40, 100];
    expect(percentileForTest(sorted, 50)).toBe(30);
    expect(percentileForTest(sorted, 95)).toBe(100);
  });
});
