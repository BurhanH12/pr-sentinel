/**
 * In-process metrics for queue depth, agent latency, and publish outcomes.
 * Exposed as JSON via GET /metrics.
 */

import { cacheHitRate, estimateCostUsd, type TokenUsage } from "./cost.js";

export interface MetricsSnapshot {
  counters: Record<string, number>;
  gauges: Record<string, number>;
  histograms: Record<
    string,
    { count: number; p50: number; p95: number; max: number }
  >;
}

class MetricsCollector {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly histogramSamples = new Map<string, number[]>();

  increment(name: string, delta = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + delta);
  }

  setGauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  observe(name: string, valueMs: number): void {
    const samples = this.histogramSamples.get(name) ?? [];
    samples.push(valueMs);
    if (samples.length > 500) {
      samples.shift();
    }
    this.histogramSamples.set(name, samples);
  }

  /**
   * Record cost/latency telemetry for one agent run. Cost is stored in USD
   * micro-units (1 USD = 1_000_000) so the histogram - which only stores
   * numeric samples - stays integral instead of losing sub-cent precision.
   *
   * Duration and the run counter are recorded unconditionally - the run
   * happened either way. The cost/token/cache-hit histograms are only
   * observed when usage was "actually reported": at least one numeric
   * field on `usage` is present. An absent `usage` object, or one with
   * every field undefined, is not a measurement - observing 0 into those
   * histograms in that case would silently read as "this run was free",
   * indistinguishable from a real zero-cost run. Instead we increment
   * `agent_usage_missing` so the gap is visible on GET /metrics.
   */
  recordAgentRun(usage: TokenUsage, model: string, durationMs: number): void {
    this.observe("agent_duration_ms", durationMs);
    this.increment("agent_runs");

    const usageReported = Object.values(usage).some(
      (value) => value !== undefined
    );
    if (!usageReported) {
      this.increment("agent_usage_missing");
      return;
    }

    const estimatedCostUsd = estimateCostUsd(usage, model);
    const hitRate = cacheHitRate(usage);
    this.observe(
      "agent_cost_usd_micros",
      Math.round(estimatedCostUsd * 1_000_000)
    );
    this.observe("agent_total_tokens", usage.totalTokens ?? 0);
    this.observe("agent_cache_hit_rate_pct", hitRate * 100);
  }

  recordInlineComments(
    posted: number,
    dropped: number,
    deduplicated: number
  ): void {
    this.increment("inline_comments_posted", posted);
    this.increment("inline_comments_dropped", dropped);
    this.increment("inline_comments_deduplicated", deduplicated);
  }

  snapshot(): MetricsSnapshot {
    const histograms: MetricsSnapshot["histograms"] = {};
    for (const [name, samples] of this.histogramSamples) {
      if (samples.length === 0) continue;
      const sorted = [...samples].sort((a, b) => a - b);
      histograms[name] = {
        count: sorted.length,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        max: sorted[sorted.length - 1]!,
      };
    }
    return {
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      histograms,
    };
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

export const metrics = new MetricsCollector();

export function percentileForTest(sorted: number[], p: number): number {
  return percentile(sorted, p);
}
