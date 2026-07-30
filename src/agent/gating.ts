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
 * Block-worthy when severity, risk, and confidence all meet configured thresholds.
 */
export function computeShouldFail(
  issues: LineComment[],
  config: ReviewRulesConfig
): GatingResult {
  const severityThreshold = SEVERITY_RANK[config.failureThreshold];
  const riskThreshold = SEVERITY_RANK[config.riskThreshold];
  const minConfidence = config.minConfidenceToBlock;

  let blockEligibleCount = 0;
  let advisoryCount = 0;

  for (const issue of issues) {
    const severityOk = SEVERITY_RANK[issue.severity] >= severityThreshold;
    const riskOk = SEVERITY_RANK[issue.risk] >= riskThreshold;
    const confidenceOk = issue.confidence >= minConfidence;

    if (severityOk && riskOk && confidenceOk) {
      blockEligibleCount += 1;
    } else if (severityOk) {
      advisoryCount += 1;
    }
  }

  return {
    shouldFail: blockEligibleCount > 0,
    gateSummary: { blockEligibleCount, advisoryCount },
  };
}

export { SEVERITY_RANK };
