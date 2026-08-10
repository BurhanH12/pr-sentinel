import { describe, it, expect, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import { updateCommitStatus } from "../github/checks.js";
import type { ReviewResult } from "../types.js";

function fakeOctokit() {
  const createCommitStatus = vi.fn().mockResolvedValue(undefined);
  return {
    octokit: { repos: { createCommitStatus } } as unknown as Octokit,
    createCommitStatus,
  };
}

describe("updateCommitStatus", () => {
  it("posts state: error with a plain failure description when the review errored", async () => {
    const { octokit, createCommitStatus } = fakeOctokit();
    const result: ReviewResult = {
      verdict: "comment",
      summary: "irrelevant",
      issues: [],
      shouldFail: true,
      errored: true,
    };

    await updateCommitStatus(octokit, "owner", "repo", "sha123", result, false);

    expect(createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "error",
        description: expect.stringContaining("could not be completed"),
      })
    );
  });

  it("still posts the existing success state and description for a clean review", async () => {
    const { octokit, createCommitStatus } = fakeOctokit();
    const result: ReviewResult = {
      verdict: "approve",
      summary: "irrelevant",
      issues: [],
      shouldFail: false,
    };

    await updateCommitStatus(octokit, "owner", "repo", "sha123", result, false);

    expect(createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "success",
        description: "No issues found — looks good to merge",
      })
    );
  });
});
