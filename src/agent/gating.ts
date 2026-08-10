import type {
  GateSummary,
  LineComment,
  ReviewRulesConfig,
  Severity,
} from "../types.js";

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

export interface GatingResult {
  shouldFail: boolean;
  gateSummary: GateSummary;
}

/**
 * Block-worthy when severity alone meets the configured threshold.
 *
 * Confidence and risk used to gate too, but both were self-reported by the
 * model: an uncalibrated number the model invented for confidence, and an
 * enum duplicating severity for risk. Gating on invented numbers produced
 * wrong-but-confident blocks, which the research names as a central cause
 * of reviewer abandonment. A calibrated substitute (cross-pass agreement)
 * is a later phase; until then severity is the only signal we trust.
 */
export function computeShouldFail(
  issues: LineComment[],
  config: ReviewRulesConfig
): GatingResult {
  const severityThreshold = SEVERITY_RANK[config.failureThreshold];

  let blockEligibleCount = 0;
  let advisoryCount = 0;

  for (const issue of issues) {
    const severityOk = SEVERITY_RANK[issue.severity] >= severityThreshold;

    if (severityOk) {
      blockEligibleCount += 1;
    } else {
      advisoryCount += 1;
    }
  }

  return {
    shouldFail: blockEligibleCount > 0,
    gateSummary: { blockEligibleCount, advisoryCount },
  };
}

export { SEVERITY_RANK };
