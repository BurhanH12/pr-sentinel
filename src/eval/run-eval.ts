import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { computeShouldFail } from "../agent/gating.js";
import type { GoldenPRFixture, EvalResult } from "./types.js";
import type { LineComment, ReviewRulesConfig } from "../types.js";

const DEFAULT_CONFIG: ReviewRulesConfig = {
  rules: "",
  blockOnFailure: true,
  failureThreshold: "high",
  minConfidenceToBlock: 0.7,
  riskThreshold: "medium",
  excludePatterns: [],
  maxFilesPerRun: 40,
  focusAreas: ["security"],
  pathRules: [],
};

const fixtureSchema = z.object({
  id: z.string(),
  description: z.string(),
  agentOutput: z.object({
    verdict: z.enum(["approve", "request_changes", "comment"]),
    summary: z.string(),
    issues: z.array(
      z.object({
        path: z.string(),
        line: z.number(),
        severity: z.enum(["critical", "high", "medium", "low", "info"]),
        confidence: z.number(),
        risk: z.enum(["critical", "high", "medium", "low", "info"]),
        body: z.string(),
      })
    ),
  }),
  expected: z.object({
    minIssues: z.number(),
    minBlockEligible: z.number().optional(),
    mustIncludePaths: z.array(z.string()).optional(),
  }),
});

async function loadFixtures(dir: string): Promise<GoldenPRFixture[]> {
  const path = join(dir, "example.json");
  const raw = await readFile(path, "utf-8");
  const parsed = fixtureSchema.parse(JSON.parse(raw));
  return [parsed as GoldenPRFixture];
}

function evaluateFixture(
  fixture: GoldenPRFixture,
  config: ReviewRulesConfig
): EvalResult {
  const details: string[] = [];
  const issues: LineComment[] = fixture.agentOutput.issues.map((i) => ({
    ...i,
    side: "RIGHT" as const,
  }));

  if (issues.length < fixture.expected.minIssues) {
    details.push(
      `Expected at least ${fixture.expected.minIssues} issues, got ${issues.length}`
    );
  }

  const { shouldFail, gateSummary } = computeShouldFail(issues, config);
  if (
    fixture.expected.minBlockEligible !== undefined &&
    gateSummary.blockEligibleCount < fixture.expected.minBlockEligible
  ) {
    details.push(
      `Expected blockEligible >= ${fixture.expected.minBlockEligible}, got ${gateSummary.blockEligibleCount}`
    );
  }

  if (fixture.expected.mustIncludePaths) {
    for (const path of fixture.expected.mustIncludePaths) {
      if (!issues.some((i) => i.path === path)) {
        details.push(`Missing expected path: ${path}`);
      }
    }
  }

  if (shouldFail && issues.length === 0) {
    details.push("shouldFail with zero issues");
  }

  return {
    fixtureId: fixture.id,
    passed: details.length === 0,
    details,
  };
}

async function main(): Promise<void> {
  const offline = process.argv.includes("--offline");
  if (!offline) {
    console.log("Live Cursor eval not implemented; use --offline");
  }

  const fixturesDir = join(process.cwd(), "evals", "golden-prs");
  const fixtures = await loadFixtures(fixturesDir);
  let passed = 0;

  for (const fixture of fixtures) {
    const result = evaluateFixture(fixture, DEFAULT_CONFIG);
    if (result.passed) {
      passed += 1;
      console.log(`PASS ${fixture.id}`);
    } else {
      console.log(`FAIL ${fixture.id}`);
      for (const d of result.details) console.log(`  - ${d}`);
    }
  }

  console.log(`\n${passed}/${fixtures.length} fixtures passed`);
  process.exit(passed === fixtures.length ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
