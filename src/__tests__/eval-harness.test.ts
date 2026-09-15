import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { buildFileSelection, buildPullRequestContext } from "../eval/harness.js";
import { ORG_DEFAULTS } from "../config/loader.js";
import type { EvalCase } from "../eval/types.js";

describe("eval harness (hermetic, no model)", () => {
  let repoPath: string;
  let baseSha: string;
  let headSha: string;

  beforeAll(async () => {
    repoPath = await mkdtemp(join(tmpdir(), "eval-harness-test-"));
    const git = simpleGit({ baseDir: repoPath });
    await git.init();
    await git.addConfig("user.email", "test@example.com");
    await git.addConfig("user.name", "test");

    await writeFile(join(repoPath, "src.ts"), "export function add(a: number, b: number): number {\n  return a - b;\n}\n");
    await git.add(["src.ts"]);
    await git.commit("chore: add function");
    baseSha = (await git.revparse(["HEAD"])).trim();

    await writeFile(join(repoPath, "src.ts"), "export function add(a: number, b: number): number {\n  return a + b;\n}\n");
    await git.add(["src.ts"]);
    await git.commit("fix: correct addition");
    headSha = (await git.revparse(["HEAD"])).trim();
  });

  afterAll(async () => {
    await rm(repoPath, { recursive: true, force: true });
  });

  describe("buildFileSelection", () => {
    it("returns one file with the right filename, status, additions, deletions and a hunks-only patch", async () => {
      const selection = await buildFileSelection(
        repoPath,
        baseSha,
        headSha,
        ORG_DEFAULTS
      );

      expect(selection.files).toHaveLength(1);
      const file = selection.files[0]!;
      expect(file.filename).toBe("src.ts");
      expect(file.status).toBe("modified");
      expect(file.additions).toBe(1);
      expect(file.deletions).toBe(1);
      expect(file.patch).toBeDefined();
      expect(file.patch!.startsWith("@@")).toBe(true);
      expect(file.patch).not.toContain("diff --git");
    });

    it("drops a file matched by an excluded glob", async () => {
      const config = {
        ...ORG_DEFAULTS,
        excludePatterns: [...ORG_DEFAULTS.excludePatterns, "src.ts"],
      };
      const selection = await buildFileSelection(repoPath, baseSha, headSha, config);
      expect(selection.files).toHaveLength(0);
      expect(selection.excludedCount).toBe(1);
    });
  });

  describe("buildPullRequestContext", () => {
    it("maps case fields onto the PR context with a deterministic synthetic PR number", () => {
      const evalCase: EvalCase = {
        id: "t1-abc1234-def5678",
        tier: 1,
        repoPath,
        headSha,
        baseSha,
        title: "chore: add function",
        expected: [{ path: "src.ts", lines: [2] }],
        provenance: { kind: "history", fixSha: "def5678", fixSubject: "fix: correct addition" },
      };

      const ctx1 = buildPullRequestContext(evalCase, "org/repo");
      const ctx2 = buildPullRequestContext(evalCase, "org/repo");

      expect(ctx1.prTitle).toBe("chore: add function");
      expect(ctx1.headSha).toBe(headSha);
      expect(ctx1.repoFullName).toBe("org/repo");
      expect(ctx1.owner).toBe("org");
      expect(ctx1.repo).toBe("repo");
      expect(typeof ctx1.prNumber).toBe("number");
      expect(ctx1.prNumber).toBeGreaterThan(0);
      // Deterministic: same case always yields the same synthetic PR number.
      expect(ctx2.prNumber).toBe(ctx1.prNumber);
    });
  });
});
