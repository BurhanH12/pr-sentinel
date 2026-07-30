/**
 * In-process metrics for queue depth, agent latency, and publish outcomes.
 * Exposed as JSON via GET /metrics.
 */

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

  recordInlineComments(posted: number, dropped: number): void {
    this.increment("inline_comments_posted", posted);
    this.increment("inline_comments_dropped", dropped);
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
