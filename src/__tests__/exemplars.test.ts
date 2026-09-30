import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildExemplarSection } from "../agent/exemplars.js";
import { buildReviewPrompt } from "../agent/runner.js";
import { ORG_DEFAULTS } from "../config/loader.js";
import type { PullRequestFile } from "../types.js";

let root: string;

async function put(rel: string, content = "export const x = 1;\n"): Promise<void> {
  await mkdir(dirname(join(root, rel)), { recursive: true });
  await writeFile(join(root, rel), content);
}

function added(filename: string): PullRequestFile {
  return { filename, status: "added", additions: 1, deletions: 0 };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "exemplars-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("buildExemplarSection", () => {
  it("returns empty for no qualifying files", async () => {
    await put("src/a/x.controller.ts");
    expect(await buildExemplarSection(root, [])).toBe("");
    expect(await buildExemplarSection(root, [added("src/plain.ts")])).toBe("");
    expect(
      await buildExemplarSection(root, [
        { ...added("src/new.controller.ts"), status: "modified" },
      ])
    ).toBe("");
    // role suffix but no siblings on disk
    expect(await buildExemplarSection(root, [added("src/new.service.ts")])).toBe("");
  });

  it("ranks same dir, then nearest dir, then alphabetical, capped at 3", async () => {
    await put("src/users/b.controller.ts");
    await put("src/users/a.controller.ts");
    await put("src/users/c.controller.ts");
    await put("src/users/d.controller.ts");
    await put("src/other/z.controller.ts");
    const out = await buildExemplarSection(root, [added("src/users/new.controller.ts")]);
    const paths = [...out.matchAll(/Exemplar: `([^`]+)`/g)].map((m) => m[1]);
    expect(paths).toEqual([
      "src/users/a.controller.ts",
      "src/users/b.controller.ts",
      "src/users/c.controller.ts",
    ]);
    expect(out).toContain("## Sibling exemplars");
  });

  it("prefers nearer directories over farther ones", async () => {
    await put("src/users/sub/deep.controller.ts");
    await put("src/orders/o.controller.ts");
    await put("lib/far.controller.ts");
    const out = await buildExemplarSection(root, [added("src/users/new.controller.ts")]);
    const paths = [...out.matchAll(/Exemplar: `([^`]+)`/g)].map((m) => m[1]);
    expect(paths).toEqual([
      "src/users/sub/deep.controller.ts",
      "src/orders/o.controller.ts",
      "lib/far.controller.ts",
    ]);
  });

  it("excludes PR changed files, ignored dirs, and oversized files", async () => {
    await put("src/pr-changed.controller.ts");
    await put("node_modules/pkg/x.controller.ts");
    await put("dist/x.controller.ts");
    await put("src/big.controller.ts", "x".repeat(21 * 1024));
    await put("src/ok.controller.ts");
    const out = await buildExemplarSection(root, [
      added("src/new.controller.ts"),
      { ...added("src/pr-changed.controller.ts"), status: "modified" },
    ]);
    const paths = [...out.matchAll(/Exemplar: `([^`]+)`/g)].map((m) => m[1]);
    expect(paths).toEqual(["src/ok.controller.ts"]);
  });

  it("truncates each exemplar and the whole section", async () => {
    for (const n of ["a", "b", "c"]) {
      await put(`src/${n}.controller.ts`, "y".repeat(10_000));
      await put(`src/${n}.service.ts`, "y".repeat(10_000));
      await put(`src/${n}.dto.ts`, "y".repeat(10_000));
    }
    const one = await buildExemplarSection(root, [added("src/new.controller.ts")]);
    expect(one).toContain("...[truncated]");
    expect(one.length).toBeLessThan(2_500 * 3 + 1_000);

    const all = await buildExemplarSection(root, [
      added("src/n.controller.ts"),
      added("src/n.service.ts"),
      added("src/n.dto.ts"),
    ]);
    expect(all.length).toBeLessThanOrEqual(12_001);
    expect(all.endsWith("...[truncated]\n")).toBe(true);
  });

  it("limits exemplars to the first 3 new files", async () => {
    for (const r of ["controller", "service", "dto", "guard"]) {
      await put(`src/old.${r}.ts`);
    }
    const out = await buildExemplarSection(root, [
      added("src/a.controller.ts"),
      added("src/b.service.ts"),
      added("src/c.dto.ts"),
      added("src/d.guard.ts"),
    ]);
    expect(out).not.toContain("old.guard.ts");
    expect(out).toContain("old.dto.ts");
  });

  it("fails soft on a missing cwd", async () => {
    expect(
      await buildExemplarSection(join(root, "nope"), [added("src/a.controller.ts")])
    ).toBe("");
  });
});

describe("prompt wiring", () => {
  it("places the exemplar section after PR identity and before requirements", () => {
    const prompt = buildReviewPrompt(
      {
        owner: "a",
        repo: "b",
        repoFullName: "a/b",
        prNumber: 1,
        prTitle: "T-MARK",
        prBody: "",
        baseBranch: "dev",
        headBranch: "f",
        headSha: "s",
        authorLogin: "u",
        cloneUrl: "https://example.invalid/x.git",
        requestedReviewers: [],
      },
      "DIFF",
      ORG_DEFAULTS,
      undefined,
      [],
      "REQ-MARK",
      "",
      "EXEMPLAR-MARK"
    );
    const i = prompt.indexOf("T-MARK");
    const e = prompt.indexOf("EXEMPLAR-MARK");
    const r = prompt.indexOf("REQ-MARK");
    expect(i).toBeLessThan(e);
    expect(e).toBeLessThan(r);
  });
});
