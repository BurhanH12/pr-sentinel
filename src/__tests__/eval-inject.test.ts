import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { mutateSource, injectCases } from "../eval/inject.js";

describe("mutateSource", () => {
  it("inverts >= to > and picks the changed line correctly", () => {
    const source = "function f(a, b) {\n  return a >= b;\n}\n";
    const mutation = mutateSource(source, ["invert-boundary"]);

    expect(mutation).not.toBeNull();
    expect(mutation?.operator).toBe("invert-boundary");
    expect(mutation?.line).toBe(2);
    expect(mutation?.before).toBe("  return a >= b;");
    expect(mutation?.after).toBe("  return a > b;");
    const lines = mutation?.mutatedSource.split("\n") ?? [];
    expect(lines[(mutation?.line ?? 0) - 1]).toBe("  return a > b;");
  });

  it("inverts a bare < to <=", () => {
    const source = "if (x < 10) {\n  doThing();\n}\n";
    const mutation = mutateSource(source, ["invert-boundary"]);

    expect(mutation?.after).toBe("if (x <= 10) {");
  });

  it("does not treat generic type parameters as a boundary comparison", () => {
    const source = [
      "function f(items: Array<Foo>, table: Map<string, number>) {",
      "  if (a > b) return a;",
      "}",
    ].join("\n");

    const mutation = mutateSource(source, ["invert-boundary"]);
    expect(mutation?.before).toBe("  if (a > b) return a;");
    expect(mutation?.after).toBe("  if (a >= b) return a;");
  });

  it("does not touch >= inside a line comment or a string literal", () => {
    const source = [
      "// a >= b is fine here",
      'const msg = "a >= b";',
      "const ok = true;",
    ].join("\n");

    const mutation = mutateSource(source, ["invert-boundary"]);
    expect(mutation).toBeNull();
  });

  it("drops an `if (!x) return ...;` guard line", () => {
    const source = "function f(x) {\n  if (!x) return null;\n  return x.value;\n}\n";
    const mutation = mutateSource(source, ["drop-null-check"]);

    expect(mutation?.operator).toBe("drop-null-check");
    expect(mutation?.line).toBe(2);
    expect(mutation?.before).toBe("  if (!x) return null;");
    expect(mutation?.after).toBe("");
  });

  it("drops an `if (x == null) ...;` guard line", () => {
    const source = "function f(x) {\n  if (x == null) return;\n  return x.value;\n}\n";
    const mutation = mutateSource(source, ["drop-null-check"]);

    expect(mutation?.before).toBe("  if (x == null) return;");
    expect(mutation?.after).toBe("");
  });

  it("turns a ?. into a . when there is no guard line to drop", () => {
    const source = "function f(x) {\n  return x?.value;\n}\n";
    const mutation = mutateSource(source, ["drop-null-check"]);

    expect(mutation?.after).toBe("  return x.value;");
  });

  it("swaps the first two simple arguments of a call", () => {
    const source = "function f() {\n  subtract(a, b);\n}\n";
    const mutation = mutateSource(source, ["swap-args"]);

    expect(mutation?.operator).toBe("swap-args");
    expect(mutation?.after).toBe("  subtract(b, a);");
  });

  it("does not swap parameter names in a function declaration", () => {
    const source = "export function computeCost(tokensIn, tokensOut) {\n  return tokensIn + tokensOut;\n}\n";
    const mutation = mutateSource(source, ["swap-args"]);

    expect(mutation).toBeNull();
  });

  it("removes one await keyword", () => {
    const source = "async function f() {\n  const x = await fetchThing();\n  return x;\n}\n";
    const mutation = mutateSource(source, ["remove-await"]);

    expect(mutation?.operator).toBe("remove-await");
    expect(mutation?.after).toBe("  const x = fetchThing();");
  });

  it("returns null when no operator finds anything to mutate", () => {
    const source = "export const NAME = \"pr-sentinel\";\n";
    expect(mutateSource(source)).toBeNull();
  });

  it("is deterministic for the same source and seed", () => {
    const source = [
      "function f(a, b, c, d) {",
      "  if (a >= b) return c;",
      "  if (c >= d) return d;",
      "}",
    ].join("\n");

    const first = mutateSource(source, ["invert-boundary"], 7);
    const second = mutateSource(source, ["invert-boundary"], 7);
    expect(second).toEqual(first);
  });
});

describe("injectCases", () => {
  let sourceRepo: string;
  let workDir: string;
  let sourceLogBefore: string;

  beforeAll(async () => {
    sourceRepo = await mkdtemp(join(tmpdir(), "eval-inject-src-"));
    const git = simpleGit({ baseDir: sourceRepo });
    await git.init();
    await git.addConfig("user.email", "src@example.com");
    await git.addConfig("user.name", "Src Bot");

    await writeFile(join(sourceRepo, "README.md"), "# test repo\n", "utf-8");
    await git.add(["README.md"]);
    await git.commit("chore: init repo");

    await writeFile(
      join(sourceRepo, "src.ts"),
      "export function pick(a: number, b: number): number {\n  if (a >= b) return a;\n  return b;\n}\n",
      "utf-8"
    );
    await git.add(["src.ts"]);
    await git.commit("feat: add pick function");

    sourceLogBefore = await git.raw(["log", "--oneline"]);

    workDir = await mkdtemp(join(tmpdir(), "eval-inject-work-"));
  });

  afterAll(async () => {
    await rm(sourceRepo, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  });

  it("produces a case with a headSha diff that changes exactly the mutated file", async () => {
    const cases = await injectCases(sourceRepo, { workDir, seed: 1 });

    expect(cases.length).toBeGreaterThan(0);
    const c = cases[0];
    expect(c).toBeDefined();
    if (!c) return;

    expect(c.tier).toBe(2);
    expect(c.provenance.kind).toBe("injected");
    expect(c.expected).toHaveLength(1);
    expect(c.id).toMatch(/^t2-/);

    const cloneGit = simpleGit({ baseDir: c.repoPath });
    const diffFiles = (
      await cloneGit.raw(["diff", "--name-only", c.baseSha, c.headSha])
    )
      .split("\n")
      .filter((f) => f.length > 0);

    expect(diffFiles).toEqual([c.expected[0]?.path]);
  });

  it("never writes to the source repo", async () => {
    const git = simpleGit({ baseDir: sourceRepo });
    const sourceLogAfter = await git.raw(["log", "--oneline"]);
    expect(sourceLogAfter).toBe(sourceLogBefore);
  });
});
