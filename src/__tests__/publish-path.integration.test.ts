import { describe, it, expect, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import {
  upsertSummaryComment,
  postInlineComments,
} from "../github/comments.js";
import { updateCommitStatus } from "../github/checks.js";
import type { LineComment, ReviewResult } from "../types.js";

/*
 * Hand-rolled fake Octokit: in-memory state for the handful of endpoints the
 * publish path touches. `pulls.listReviewComments` reads back whatever
 * `pulls.createReview` / `pulls.createReviewComment` recorded, so a second
 * run against the same fake sees the first run's comments - this is what
 * makes the dedup assertions below meaningful instead of trivially true.
 */
function fakeOctokit() {
  const summaryComments: { id: number; body: string }[] = [];
  const reviewComments: { path: string; line: number; body: string }[] = [];
  const commitStatuses: { state: string; description: string }[] = [];
  let nextCommentId = 1;
  let rejectNextReview = false;

  const issuesListComments = vi.fn(async () => ({
    data: summaryComments.map((c) => ({ id: c.id, body: c.body })),
  }));

  const issuesCreateComment = vi.fn(async (params: { body: string }) => {
    const comment = { id: nextCommentId++, body: params.body };
    summaryComments.push(comment);
    return { data: comment };
  });

  const issuesUpdateComment = vi.fn(
    async (params: { comment_id: number; body: string }) => {
      const existing = summaryComments.find((c) => c.id === params.comment_id);
      if (existing) existing.body = params.body;
      return { data: existing };
    }
  );

  const pullsListReviewComments = vi.fn(async (params: { page: number }) => {
    if (params.page > 1) return { data: [] };
    return {
      data: reviewComments.map((c) => ({
        path: c.path,
        line: c.line,
        original_line: c.line,
        body: c.body,
      })),
    };
  });

  const pullsCreateReview = vi.fn(
    async (params: {
      comments: { path: string; line: number; body: string }[];
    }) => {
      if (rejectNextReview) {
        rejectNextReview = false;
        throw new Error("422 Unprocessable Entity");
      }
      for (const c of params.comments) {
        reviewComments.push({ path: c.path, line: c.line, body: c.body });
      }
      return { data: {} };
    }
  );

  const pullsCreateReviewComment = vi.fn(
    async (params: { path: string; line: number; body: string }) => {
      reviewComments.push({
        path: params.path,
        line: params.line,
        body: params.body,
      });
      return { data: {} };
    }
  );

  const reposCreateCommitStatus = vi.fn(
    async (params: { state: string; description: string }) => {
      commitStatuses.push({
        state: params.state,
        description: params.description,
      });
      return { data: {} };
    }
  );

  const octokit = {
    issues: {
      listComments: issuesListComments,
      createComment: issuesCreateComment,
      updateComment: issuesUpdateComment,
    },
    pulls: {
      listReviewComments: pullsListReviewComments,
      createReview: pullsCreateReview,
      createReviewComment: pullsCreateReviewComment,
    },
    repos: {
      createCommitStatus: reposCreateCommitStatus,
    },
  } as unknown as Octokit;

  return {
    octokit,
    issuesListComments,
    issuesCreateComment,
    issuesUpdateComment,
    pullsListReviewComments,
    pullsCreateReview,
    pullsCreateReviewComment,
    reposCreateCommitStatus,
    reviewComments,
    rejectNextReviewOnce: () => {
      rejectNextReview = true;
    },
  };
}

function makeResult(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    verdict: "comment",
    summary: "irrelevant",
    issues: [],
    shouldFail: false,
    ...overrides,
  };
}

describe("publish path integration", () => {
  it("first run creates one summary, posts a single review, and one commit status", async () => {
    const fake = fakeOctokit();
    const changedPaths = new Set(["src/a.ts", "src/b.ts"]);
    const issues: LineComment[] = [
      { path: "src/a.ts", line: 10, side: "RIGHT", body: "issue A", severity: "high" },
      { path: "src/b.ts", line: 20, side: "RIGHT", body: "issue B", severity: "medium" },
      // Outside the PR's changed-path set - must never be posted.
      { path: "src/outside.ts", line: 5, side: "RIGHT", body: "issue outside", severity: "low" },
    ];

    await upsertSummaryComment(fake.octokit, "owner", "repo", 1, makeResult());
    expect(fake.issuesCreateComment).toHaveBeenCalledTimes(1);
    expect(fake.issuesUpdateComment).not.toHaveBeenCalled();

    const result = await postInlineComments(
      fake.octokit,
      "owner",
      "repo",
      1,
      "sha1",
      issues,
      changedPaths
    );

    expect(result).toEqual({ posted: 2, dropped: 0, deduplicated: 0 });
    expect(fake.pullsCreateReview).toHaveBeenCalledTimes(1);
    expect(fake.pullsCreateReview).toHaveBeenCalledWith(
      expect.objectContaining({ event: "COMMENT" })
    );
    const firstCallComments = fake.pullsCreateReview.mock.calls[0]![0].comments;
    expect(firstCallComments).toHaveLength(2);
    expect(fake.reviewComments.some((c) => c.body.includes("issue outside"))).toBe(
      false
    );

    await updateCommitStatus(
      fake.octokit,
      "owner",
      "repo",
      "sha1",
      makeResult(),
      false
    );
    expect(fake.reposCreateCommitStatus).toHaveBeenCalledTimes(1);
  });

  it("second run over the same fake state updates the summary and drops duplicate inline comments (§3.2 regression)", async () => {
    const fake = fakeOctokit();
    const changedPathsRun1 = new Set(["src/a.ts", "src/b.ts"]);
    const issuesRun1: LineComment[] = [
      { path: "src/a.ts", line: 10, side: "RIGHT", body: "issue A", severity: "high" },
      { path: "src/b.ts", line: 20, side: "RIGHT", body: "issue B", severity: "medium" },
    ];

    await upsertSummaryComment(fake.octokit, "owner", "repo", 1, makeResult());
    await postInlineComments(
      fake.octokit,
      "owner",
      "repo",
      1,
      "sha1",
      issuesRun1,
      changedPathsRun1
    );
    await updateCommitStatus(fake.octokit, "owner", "repo", "sha1", makeResult(), false);

    // Second run: same file, a re-post of the first finding (shifted by one
    // line) plus one genuinely new finding on a third file.
    const changedPathsRun2 = new Set(["src/a.ts", "src/b.ts", "src/c.ts"]);
    const issuesRun2: LineComment[] = [
      { path: "src/a.ts", line: 11, side: "RIGHT", body: "issue A again", severity: "high" },
      { path: "src/c.ts", line: 30, side: "RIGHT", body: "issue C new", severity: "critical" },
    ];

    await upsertSummaryComment(fake.octokit, "owner", "repo", 1, makeResult());

    // Regression assertion: the summary comment is updated, never duplicated.
    expect(fake.issuesCreateComment).toHaveBeenCalledTimes(1);
    expect(fake.issuesUpdateComment).toHaveBeenCalledTimes(1);

    const result = await postInlineComments(
      fake.octokit,
      "owner",
      "repo",
      1,
      "sha2",
      issuesRun2,
      changedPathsRun2
    );

    expect(result).toEqual({ posted: 1, dropped: 0, deduplicated: 1 });
    expect(fake.pullsCreateReview).toHaveBeenCalledTimes(2);
    const secondCallComments = fake.pullsCreateReview.mock.calls[1]![0].comments;
    expect(secondCallComments).toHaveLength(1);
    expect(secondCallComments[0]!.path).toBe("src/c.ts");

    await updateCommitStatus(fake.octokit, "owner", "repo", "sha2", makeResult(), false);
    expect(fake.reposCreateCommitStatus).toHaveBeenCalledTimes(2);
  });

  it("falls back to per-comment posts when the bulk review is rejected", async () => {
    const fake = fakeOctokit();
    const changedPaths = new Set(["src/a.ts", "src/b.ts"]);
    const issues: LineComment[] = [
      { path: "src/a.ts", line: 10, side: "RIGHT", body: "issue A", severity: "high" },
      { path: "src/b.ts", line: 20, side: "RIGHT", body: "issue B", severity: "medium" },
    ];
    fake.rejectNextReviewOnce();

    const result = await postInlineComments(
      fake.octokit,
      "owner",
      "repo",
      1,
      "sha1",
      issues,
      changedPaths
    );

    expect(fake.pullsCreateReview).toHaveBeenCalledTimes(1);
    expect(fake.pullsCreateReviewComment).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ posted: 2, dropped: 0, deduplicated: 0 });
  });
});
