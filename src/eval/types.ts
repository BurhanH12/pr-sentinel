import type { LineComment, Severity, Verdict } from "../types.js";

export interface GoldenPRFixture {
  id: string;
  description: string;
  /** Stored agent JSON output for offline eval */
  agentOutput: {
    verdict: Verdict;
    summary: string;
    issues: Array<{
      path: string;
      line: number;
      severity: Severity;
      confidence: number;
      risk: Severity;
      body: string;
    }>;
  };
  expected: {
    minIssues: number;
    minBlockEligible?: number;
    mustIncludePaths?: string[];
  };
}

export interface EvalResult {
  fixtureId: string;
  passed: boolean;
  details: string[];
}
