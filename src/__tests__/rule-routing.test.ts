import { readFile } from "node:fs/promises";
import { describe, it, expect } from "vitest";
import { filterRulesByStacks } from "../agent/rule-routing.js";
import { buildReviewPrompt } from "../agent/runner.js";
import { ORG_DEFAULTS } from "../config/loader.js";
import type { PullRequestContext } from "../types.js";

const SAMPLE = [
  "UNIVERSAL-A",
  "<!-- stack: nestjs -->",
  "NEST-ONLY",
  "<!-- /stack -->",
  "<!-- stack: nextjs,react -->",
  "WEB-ONLY",
  "<!-- /stack -->",
  "UNIVERSAL-B",
].join("\n");

describe("filterRulesByStacks", () => {
  it("keeps untagged text and matching tagged blocks, drops the rest", () => {
    const out = filterRulesByStacks(SAMPLE, ["nestjs"]);
    expect(out).toContain("UNIVERSAL-A");
    expect(out).toContain("UNIVERSAL-B");
    expect(out).toContain("NEST-ONLY");
    expect(out).not.toContain("WEB-ONLY");
  });

  it("keeps a multi-stack block when any one of its stacks is detected", () => {
    expect(filterRulesByStacks(SAMPLE, ["react"])).toContain("WEB-ONLY");
    expect(filterRulesByStacks(SAMPLE, ["nextjs"])).toContain("WEB-ONLY");
    expect(filterRulesByStacks(SAMPLE, ["react"])).not.toContain("NEST-ONLY");
  });

  it("never emits marker comments", () => {
    for (const stacks of [["nestjs"], ["react"], ["nestjs", "react"]] as const) {
      expect(filterRulesByStacks(SAMPLE, [...stacks])).not.toContain("<!--");
    }
  });

  it("keeps everything when no stack was detected", () => {
    expect(filterRulesByStacks(SAMPLE, [])).toBe(SAMPLE);
  });

  it.each([
    ["unclosed", "<!-- stack: nestjs -->\nX"],
    ["stray close", "X\n<!-- /stack -->"],
    ["nested", "<!-- stack: nestjs -->\n<!-- stack: react -->\nX\n<!-- /stack -->"],
    ["unknown stack", "<!-- stack: vue -->\nX\n<!-- /stack -->"],
    ["malformed open", "<!-- stack nestjs -->\nX\n<!-- /stack -->"],
  ])("fails open on %s markers", (_name, text) => {
    expect(filterRulesByStacks(text, ["react"])).toBe(text);
  });

  it("gives a nestjs-only prompt no react-tagged text from the bundled rules", async () => {
    const rules = await readFile("cursor-config/review-rules.md", "utf-8");
    const pr: PullRequestContext = {
      owner: "a",
      repo: "b",
      repoFullName: "a/b",
      prNumber: 1,
      prTitle: "t",
      prBody: "",
      baseBranch: "dev",
      headBranch: "h",
      headSha: "abc",
      authorLogin: "u",
      cloneUrl: "https://example.invalid/x.git",
      requestedReviewers: [],
    };
    const prompt = buildReviewPrompt(pr, "diff", {
      ...ORG_DEFAULTS,
      rules: filterRulesByStacks(rules, ["nestjs"]),
    });
    expect(prompt).toContain("@UseGuards()");
    expect(prompt).not.toContain("barrel-file imports");
    expect(prompt).not.toContain("dangerouslySetInnerHTML");
    expect(prompt).not.toContain("<!-- stack");
  });
});
