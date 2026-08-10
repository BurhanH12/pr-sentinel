/**
 * Cost estimation and cache-hit metrics for a single Cursor agent run.
 *
 * `TokenUsage` mirrors the token fields the Cursor SDK reports on a
 * finished run (see agent/cursor-invoke.ts). All fields are optional
 * because the SDK may omit usage entirely.
 *
 * Ground truth as of `@cursor/sdk@1.0.13`: `RunResult`
 * (`node_modules/@cursor/sdk/dist/esm/run.d.ts`) declares only `id`,
 * `status`, `result`, `model`, `durationMs`, and `git` - no `usage` field,
 * and none of the SDK's message types declare usage either. So everything
 * in this module is plumbing that stays dormant - `usage` will be `{}` (or
 * all-undefined) on every run - until the SDK actually starts reporting
 * it. This is what the type declarations show, not a claim about what the
 * SDK does at runtime; `metrics.recordAgentRun`'s `agent_usage_missing`
 * counter (src/observability/metrics.ts) is how you tell, from the running
 * system, whether usage ever arrives.
 */
export interface TokenUsage {
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

/**
 * USD price per million tokens, keyed by model id. These numbers are a
 * hand-entered estimate from Cursor's published pricing at the time this
 * file was written - they must be updated as Cursor's pricing changes.
 * The metric this feeds exists to track cost trend and order of magnitude,
 * not to reproduce Cursor's actual bill.
 */
const MODEL_PRICING: Record<string, ModelPricing> = {
  "composer-2.5": { inputPerMTok: 1.25, outputPerMTok: 6 },
};

/**
 * Pricing used for any model id not present in MODEL_PRICING, so an
 * unrecognised model id never throws - it just estimates using the same
 * numbers as the seeded default model.
 */
const FALLBACK_PRICING: ModelPricing = MODEL_PRICING["composer-2.5"]!;

/**
 * Estimated USD cost of a run. Cached-read tokens are billed at 10% of the
 * input rate, so they are counted separately at the discounted rate and
 * removed from the full-price input token count (clamped at zero in case
 * cacheReadTokens exceeds inputTokens).
 */
export function estimateCostUsd(usage: TokenUsage, model: string): number {
  const pricing = MODEL_PRICING[model] ?? FALLBACK_PRICING;
  const inputTokens = usage.inputTokens ?? 0;
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;

  const billedInputTokens = Math.max(0, inputTokens - cacheReadTokens);
  const inputCost = (billedInputTokens * pricing.inputPerMTok) / 1_000_000;
  const cachedReadCost =
    (cacheReadTokens * pricing.inputPerMTok * 0.1) / 1_000_000;
  const outputCost = (outputTokens * pricing.outputPerMTok) / 1_000_000;

  return inputCost + cachedReadCost + outputCost;
}

/** Fraction of input tokens served from cache. 0 when inputTokens is falsy. */
export function cacheHitRate(usage: TokenUsage): number {
  const inputTokens = usage.inputTokens ?? 0;
  if (!inputTokens) return 0;
  return (usage.cacheReadTokens ?? 0) / inputTokens;
}
