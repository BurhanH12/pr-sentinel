import { describe, it, expect } from "vitest";
import {
  parseAgentOutput,
  buildParseFailureResult,
  neutralisePreviewFences,
} from "../agent/runner.js";

describe("parseAgentOutput", () => {
  it("yields ok: false, reason: no_json when the output has no { at all", () => {
    const outcome = parseAgentOutput("The PR looks fine, no issues to report.");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("no_json");
  });

  it("yields ok: false, reason: invalid_json for a {...} block that is not valid JSON", () => {
    const outcome = parseAgentOutput('{ "verdict": "approve", oops }');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("invalid_json");
  });

  it("yields ok: false, reason: schema_mismatch for valid JSON missing verdict", () => {
    const outcome = parseAgentOutput(
      JSON.stringify({ summary: "looks fine", issues: [] })
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("schema_mismatch");
  });

  it("yields ok: true with the parsed issues for a valid payload", () => {
    const outcome = parseAgentOutput(
      JSON.stringify({
        verdict: "comment",
        summary: "Found one nit.",
        issues: [
          {
            path: "src/a.ts",
            line: 10,
            side: "RIGHT",
            severity: "low",
            body: "nit",
          },
        ],
      })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.output.verdict).toBe("comment");
      expect(outcome.output.issues).toHaveLength(1);
      expect(outcome.output.issues[0]?.path).toBe("src/a.ts");
    }
  });

  it("parses successfully and truncates to the first 6 when checked has 7 entries", () => {
    const checked = Array.from({ length: 7 }, (_, i) => `checked item ${i}`);
    const outcome = parseAgentOutput(
      JSON.stringify({
        verdict: "approve",
        summary: "All good.",
        checked,
        issues: [],
      })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.output.checked).toHaveLength(6);
      expect(outcome.output.checked).toEqual(checked.slice(0, 6));
    }
  });

  it("leaves a 6-entry checked list untouched", () => {
    const checked = Array.from({ length: 6 }, (_, i) => `checked item ${i}`);
    const outcome = parseAgentOutput(
      JSON.stringify({
        verdict: "approve",
        summary: "All good.",
        checked,
        issues: [],
      })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.output.checked).toEqual(checked);
    }
  });
});

describe("buildParseFailureResult", () => {
  it("produces a fail-closed ReviewResult with the raw preview in the summary", () => {
    const raw = "not json at all, just prose from a confused model run";
    const outcome = parseAgentOutput(raw);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a parse failure");

    const result = buildParseFailureResult(outcome, raw);

    expect(result.shouldFail).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.verdict).toBe("comment");
    expect(result.summary).toContain(raw.slice(0, 300));
    expect(result.summary).toContain("no_json");
  });
});

describe("neutralisePreviewFences", () => {
  it("breaks a run of exactly three backticks so it can't close a markdown fence", () => {
    const text = "before ```js\nevil()\n``` after";
    const result = neutralisePreviewFences(text);
    expect(result).not.toContain("```");
    expect(result).toContain("before");
    expect(result).toContain("after");
  });

  it("breaks a run of five backticks", () => {
    const text = "prefix ````` suffix";
    const result = neutralisePreviewFences(text);
    expect(result).not.toMatch(/`{3,}/);
  });

  it("leaves text with no backticks unchanged", () => {
    const text = "just plain prose, no fences here";
    expect(neutralisePreviewFences(text)).toBe(text);
  });
});
