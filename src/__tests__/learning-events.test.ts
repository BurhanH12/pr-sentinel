import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const mockEnv = vi.hoisted(() => ({
  REVIEW_LEARNING_ENABLED: true,
  REVIEW_LEARNING_PATH: "",
}));

vi.mock("../env.js", () => ({
  env: mockEnv,
}));

vi.mock("../utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

describe("recordMergeEvent", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "learning-"));
    path = join(dir, "events.jsonl");
    mockEnv.REVIEW_LEARNING_PATH = path;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("appends JSONL when enabled", async () => {
    const { recordMergeEvent } = await import("../learning/events.js");
    await recordMergeEvent(
      {
        owner: "o",
        repo: "r",
        repoFullName: "o/r",
        prNumber: 9,
        prTitle: "t",
        prBody: "",
        baseBranch: "dev",
        headBranch: "f",
        headSha: "sha1",
        authorLogin: "a",
        cloneUrl: "",
        requestedReviewers: [],
      },
      "merge-sha"
    );
    const content = await readFile(path, "utf-8");
    expect(content).toContain('"type":"pr_merged"');
    expect(content).toContain('"prNumber":9');
  });
});
