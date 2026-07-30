import { describe, it, expect } from "vitest";
import { selectReviewFiles } from "../github/diff.js";
import type { PullRequestFile } from "../types.js";

function file(name: string): PullRequestFile {
  return {
    filename: name,
    status: "modified",
    additions: 1,
    deletions: 0,
  };
}

describe("selectReviewFiles", () => {
  it("returns all files when under cap and nothing excluded", () => {
    const all = [file("a.ts"), file("b.ts")];
    const result = selectReviewFiles(all, [], 40);
    expect(result.files).toHaveLength(2);
    expect(result.truncatedCount).toBe(0);
    expect(result.excludedCount).toBe(0);
    expect(result.omittedFiles).toEqual([]);
  });

  it("excludes files matching exclude patterns", () => {
    const all = [file("src/a.ts"), file("dist/b.js")];
    const result = selectReviewFiles(all, ["dist/**"], 40);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.filename).toBe("src/a.ts");
    expect(result.excludedCount).toBe(1);
    expect(result.truncatedCount).toBe(0);
  });

  it("truncates eligible files and lists omitted sample", () => {
    const all = Array.from({ length: 5 }, (_, i) => file(`f${i}.ts`));
    const result = selectReviewFiles(all, [], 2);
    expect(result.files).toHaveLength(2);
    expect(result.truncatedCount).toBe(3);
    expect(result.omittedFiles).toEqual(["f2.ts", "f3.ts", "f4.ts"]);
    expect(result.maxFiles).toBe(2);
  });

  it("prioritizes security, migrations, API routes, package files, and larger diffs when capped", () => {
    const all = [
      { ...file("src/components/Button.tsx"), additions: 500 },
      { ...file("apps/api/src/users/users.controller.ts"), additions: 12 },
      { ...file("package.json"), additions: 4 },
      { ...file("apps/api/src/migrations/20260609-add-users.ts"), additions: 8 },
      { ...file("src/auth/session.ts"), additions: 2 },
      { ...file(".env.example"), additions: 1 },
      { ...file("src/lib/big-change.ts"), additions: 300 },
    ];

    const result = selectReviewFiles(all, [], 5);

    expect(result.files.map((f) => f.filename)).toEqual([
      "src/auth/session.ts",
      "apps/api/src/migrations/20260609-add-users.ts",
      "apps/api/src/users/users.controller.ts",
      "package.json",
      ".env.example",
    ]);
    expect(result.omittedFiles).toEqual([
      "src/components/Button.tsx",
      "src/lib/big-change.ts",
    ]);
  });
});
