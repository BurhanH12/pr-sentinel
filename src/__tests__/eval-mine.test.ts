import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import {
  mineHistoryCases,
  isFixSubject,
  parseRemovedLineRanges,
  parseBlamePorcelain,
} from "../eval/mine.js";

describe("isFixSubject", () => {
  it("matches fix words as whole words, case-insensitively", () => {
    expect(isFixSubject("fix: correct off-by-one")).toBe(true);
    expect(isFixSubject("Fixes #123")).toBe(true);
    expect(isFixSubject("HOTFIX: patch prod")).toBe(true);
    expect(isFixSubject("bugfix for parser")).toBe(true);
    expect(isFixSubject("apply patch for regression")).toBe(true);
    expect(isFixSubject('Revert "feat: add thing"')).toBe(true);
  });

  it("does not match fix as a substring of another word", () => {
    expect(isFixSubject("feat: add prefix support")).toBe(false);
    expect(isFixSubject("feat: add suffix support")).toBe(false);
    expect(isFixSubject("chore: bump version")).toBe(false);
  });
});

describe("parseRemovedLineRanges", () => {
  it("extracts an old-side range from a unified diff", () => {
    const diff = [
      "diff --git a/src.ts b/src.ts",
      "index 111..222 100644",
      "--- a/src.ts",
      "+++ b/src.ts",
      "@@ -2,1 +2,1 @@",
      "-  return a - b;",
      "+  return a + b;",
    ].join("\n");

    expect(parseRemovedLineRanges(diff)).toEqual([
      { path: "src.ts", start: 2, end: 2 },
    ]);
  });

  it("groups consecutive removed lines and ignores add-only hunks", () => {
    const diff = [
      "diff --git a/src.ts b/src.ts",
      "--- a/src.ts",
      "+++ b/src.ts",
      "@@ -5,3 +5,1 @@",
      "-line5",
      "-line6",
      "-line7",
      "+replacement",
      "@@ -20,0 +19,2 @@",
      "+added only, no removal",
      "+another add",
    ].join("\n");

    expect(parseRemovedLineRanges(diff)).toEqual([
      { path: "src.ts", start: 5, end: 7 },
    ]);
  });

  it("ignores new-file hunks (old side is /dev/null)", () => {
    const diff = [
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1,2 @@",
      "+line1",
      "+line2",
    ].join("\n");

    expect(parseRemovedLineRanges(diff)).toEqual([]);
  });
});

describe("parseBlamePorcelain", () => {
  it("parses sha and original line from header lines only", () => {
    const output = [
      "abc123def456abc123def456abc123def456abcd 2 2 1",
      "author Jane",
      "author-mail <jane@example.com>",
      "author-time 1700000000",
      "summary feat: add add function",
      "\t  return a - b;",
    ].join("\n");

    expect(parseBlamePorcelain(output)).toEqual([
      { sha: "abc123def456abc123def456abc123def456abcd", originalLine: 2 },
    ]);
  });

  it("returns one entry per blamed line", () => {
    const sha = "1".repeat(39) + "a";
    const output = [
      `${sha} 5 5 2`,
      "author Jane",
      "\tline5",
      `${sha} 6 6`,
      "\tline6",
    ].join("\n");

    expect(parseBlamePorcelain(output)).toEqual([
      { sha, originalLine: 5 },
      { sha, originalLine: 6 },
    ]);
  });
});

describe("mineHistoryCases", () => {
  let repoDir: string;
  let introducingSha: string;
  let fixSha: string;

  beforeAll(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "eval-mine-"));
    const git = simpleGit({ baseDir: repoDir });
    await git.init();
    await git.addConfig("user.email", "eval@example.com");
    await git.addConfig("user.name", "Eval Bot");

    await writeFile(join(repoDir, "README.md"), "# test repo\n", "utf-8");
    await git.add(["README.md"]);
    await git.commit("chore: init repo");

    await writeFile(
      join(repoDir, "src.ts"),
      "export function add(a: number, b: number): number {\n  return a - b;\n}\n",
      "utf-8"
    );
    await git.add(["src.ts"]);
    await git.commit("feat: add add function");
    introducingSha = (await git.raw(["rev-parse", "HEAD"])).trim();

    await writeFile(
      join(repoDir, "src.ts"),
      "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
      "utf-8"
    );
    await git.add(["src.ts"]);
    await git.commit("fix: correct add operator");
    fixSha = (await git.raw(["rev-parse", "HEAD"])).trim();
  });

  afterAll(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("finds the introducing commit and points at the buggy line", async () => {
    const cases = await mineHistoryCases(repoDir);

    expect(cases).toHaveLength(1);
    const c = cases[0]!;
    expect(c.tier).toBe(1);
    expect(c.headSha).toBe(introducingSha);
    expect(c.expected).toEqual([{ path: "src.ts", lines: [2] }]);
    expect(c.provenance).toEqual({
      kind: "history",
      fixSha,
      fixSubject: "fix: correct add operator",
    });
  });

  it("rejects a case where the fix commit predates the introducing commit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eval-mine-backdated-"));
    try {
      const git = simpleGit({ baseDir: dir });
      await git.init();
      await git.addConfig("user.email", "eval@example.com");
      await git.addConfig("user.name", "Eval Bot");

      await writeFile(join(dir, "README.md"), "# test repo\n", "utf-8");
      await git.add(["README.md"]);
      await git.commit("chore: init repo");

      await writeFile(
        join(dir, "src.ts"),
        "export function sub(a: number, b: number): number {\n  return a + b;\n}\n",
        "utf-8"
      );
      await git.add(["src.ts"]);
      await git.commit("feat: add sub function");

      // Backdate the "fix" commit to 5 days before the introducing commit -
      // within fixWindowDays (30) but on the wrong side of it. Squash
      // merges / cherry-picked backports / rebases can produce exactly
      // this non-monotonic committer-date ordering, and it must be
      // rejected by the directional window check, not just a large |delta|.
      const backdated = new Date(
        Date.now() - 5 * 24 * 60 * 60 * 1000
      ).toISOString();
      const prevAuthorDate = process.env.GIT_AUTHOR_DATE;
      const prevCommitterDate = process.env.GIT_COMMITTER_DATE;
      process.env.GIT_AUTHOR_DATE = backdated;
      process.env.GIT_COMMITTER_DATE = backdated;
      try {
        await writeFile(
          join(dir, "src.ts"),
          "export function sub(a: number, b: number): number {\n  return a - b;\n}\n",
          "utf-8"
        );
        await git.add(["src.ts"]);
        await git.commit("fix: correct sub operator");
      } finally {
        if (prevAuthorDate === undefined) delete process.env.GIT_AUTHOR_DATE;
        else process.env.GIT_AUTHOR_DATE = prevAuthorDate;
        if (prevCommitterDate === undefined) {
          delete process.env.GIT_COMMITTER_DATE;
        } else {
          process.env.GIT_COMMITTER_DATE = prevCommitterDate;
        }
      }

      const cases = await mineHistoryCases(dir);
      expect(cases).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty array for a repo with no qualifying history", async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), "eval-mine-empty-"));
    try {
      const git = simpleGit({ baseDir: emptyDir });
      await git.init();
      await git.addConfig("user.email", "eval@example.com");
      await git.addConfig("user.name", "Eval Bot");
      await writeFile(join(emptyDir, "README.md"), "# empty\n", "utf-8");
      await git.add(["README.md"]);
      await git.commit("chore: init repo");

      const cases = await mineHistoryCases(emptyDir);
      expect(cases).toEqual([]);
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it("throws on a repoPath that is not a git repository", async () => {
    const notARepo = await mkdtemp(join(tmpdir(), "eval-mine-notgit-"));
    try {
      await expect(mineHistoryCases(notARepo)).rejects.toThrow();
    } finally {
      await rm(notARepo, { recursive: true, force: true });
    }
  });
});
