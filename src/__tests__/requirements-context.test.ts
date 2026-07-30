import { describe, it, expect, vi } from "vitest";
import { fetchRequirementContext } from "../context/requirements.js";
import type { PullRequestContext } from "../types.js";

const pr: PullRequestContext = {
  owner: "org",
  repo: "app",
  repoFullName: "org/app",
  prNumber: 1,
  prTitle: "Fix auth",
  prBody: "Fixes #42",
  baseBranch: "dev",
  headBranch: "feature",
  headSha: "abc",
  authorLogin: "dev",
  cloneUrl: "https://github.com/org/app.git",
  requestedReviewers: [],
};

describe("fetchRequirementContext", () => {
  it("parses Fixes #N and fetches issue body", async () => {
    const octokit = {
      issues: {
        get: vi.fn().mockResolvedValue({
          data: { title: "Add OAuth", body: "Acceptance: use PKCE" },
        }),
      },
    };

    const ctx = await fetchRequirementContext(octokit as never, pr);

    expect(ctx.linkedIssueNumbers).toEqual([42]);
    expect(ctx.promptSection).toContain("Issue #42");
    expect(ctx.promptSection).toContain("PKCE");
  });

  it("returns product context note when no links found", async () => {
    const ctx = await fetchRequirementContext(
      { issues: { get: vi.fn() } } as never,
      { ...pr, prBody: "No ticket here" }
    );
    expect(ctx.linkedIssueNumbers).toEqual([]);
    expect(ctx.promptSection).toContain("No linked ticket");
  });
});
