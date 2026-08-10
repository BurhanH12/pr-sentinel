import { describe, it, expect } from "vitest";
import { metrics, percentileForTest } from "../observability/metrics.js";

describe("percentile", () => {
  it("computes p50 and p95 from sorted samples", () => {
    const sorted = [10, 20, 30, 40, 100];
    expect(percentileForTest(sorted, 50)).toBe(30);
    expect(percentileForTest(sorted, 95)).toBe(100);
  });
});

/*
 * `metrics` is a module-level singleton, so state accumulates across tests
 * in this file (and would leak across test files if they touched the same
 * counters/histograms). Rather than add a reset() method to production
 * code purely to make tests convenient, these tests snapshot before/after
 * and assert on the *delta*, which is correct regardless of what other
 * tests already recorded.
 */
describe("recordAgentRun", () => {
  it("records duration and agent_usage_missing but not cost/token/cache histograms when usage is absent", () => {
    const before = metrics.snapshot();
    metrics.recordAgentRun({}, "composer-2.5", 500);
    const after = metrics.snapshot();

    expect(after.counters.agent_runs).toBe(
      (before.counters.agent_runs ?? 0) + 1
    );
    expect(after.counters.agent_usage_missing).toBe(
      (before.counters.agent_usage_missing ?? 0) + 1
    );
    expect(after.histograms.agent_duration_ms!.count).toBe(
      (before.histograms.agent_duration_ms?.count ?? 0) + 1
    );

    // No usage was reported, so none of these should have received a sample.
    expect(after.histograms.agent_cost_usd_micros?.count ?? 0).toBe(
      before.histograms.agent_cost_usd_micros?.count ?? 0
    );
    expect(after.histograms.agent_total_tokens?.count ?? 0).toBe(
      before.histograms.agent_total_tokens?.count ?? 0
    );
    expect(after.histograms.agent_cache_hit_rate_pct?.count ?? 0).toBe(
      before.histograms.agent_cache_hit_rate_pct?.count ?? 0
    );
  });

  it("records all histograms and agent_runs, but not agent_usage_missing, when usage is present", () => {
    const before = metrics.snapshot();
    metrics.recordAgentRun(
      { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      "composer-2.5",
      750
    );
    const after = metrics.snapshot();

    expect(after.counters.agent_runs).toBe(
      (before.counters.agent_runs ?? 0) + 1
    );
    expect(after.counters.agent_usage_missing ?? 0).toBe(
      before.counters.agent_usage_missing ?? 0
    );
    expect(after.histograms.agent_duration_ms!.count).toBe(
      (before.histograms.agent_duration_ms?.count ?? 0) + 1
    );
    expect(after.histograms.agent_cost_usd_micros!.count).toBe(
      (before.histograms.agent_cost_usd_micros?.count ?? 0) + 1
    );
    expect(after.histograms.agent_total_tokens!.count).toBe(
      (before.histograms.agent_total_tokens?.count ?? 0) + 1
    );
    expect(after.histograms.agent_cache_hit_rate_pct!.count).toBe(
      (before.histograms.agent_cache_hit_rate_pct?.count ?? 0) + 1
    );
  });
});
