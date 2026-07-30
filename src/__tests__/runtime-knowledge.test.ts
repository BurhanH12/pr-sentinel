import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach } from "vitest";
import {
  buildRuntimeKnowledgeSection,
  detectReviewStacks,
} from "../agent/runtime-knowledge.js";
import type { PathRulePack } from "../types.js";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "runtime-knowledge-"));
});

describe("detectReviewStacks", () => {
  it("detects NestJS, Next.js, and React from package metadata and paths", () => {
    const stacks = detectReviewStacks(
      {
        dependencies: {
          "@nestjs/common": "^10.0.0",
          next: "^15.0.0",
          react: "^19.0.0",
        },
      },
      ["apps/api/src/users.controller.ts", "apps/web/app/page.tsx"]
    );

    expect(stacks).toEqual(["nestjs", "nextjs", "react"]);
  });
});

describe("buildRuntimeKnowledgeSection", () => {
  it("injects target repo context and matched skill excerpts", async () => {
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({ dependencies: { "@nestjs/core": "^10.0.0" } }),
      "utf-8"
    );
    await writeFile(join(cwd, "AGENTS.md"), "Repo-specific agent rules", "utf-8");
    await mkdir(join(cwd, "docs"), { recursive: true });
    await writeFile(join(cwd, "CONTEXT.md"), "Domain context", "utf-8");

    const matchedPathRules: PathRulePack[] = [
      {
        patterns: ["apps/api/**"],
        rules: "API paths must preserve module boundaries.",
        skillRefs: ["nestjs-best-practices"],
      },
    ];

    const section = await buildRuntimeKnowledgeSection(
      cwd,
      ["apps/api/src/users.controller.ts"],
      matchedPathRules
    );

    expect(section).toContain("## Runtime project knowledge");
    expect(section).toContain("Detected stacks: nestjs");
    expect(section).toContain("Repo-specific agent rules");
    expect(section).toContain("Domain context");
    expect(section).toContain("API paths must preserve module boundaries.");
    expect(section).toContain("nestjs-best-practices");
  });
});
