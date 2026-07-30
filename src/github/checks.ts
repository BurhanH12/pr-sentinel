import type { Octokit } from "@octokit/rest";
import type { ReviewResult } from "../types.js";
import { logger } from "../utils/logger.js";

/*
 * GitHub's Checks API (check runs) requires GitHub App authentication and
 * rejects every PAT with 403. We use commit statuses instead:
 *   POST /repos/{owner}/{repo}/statuses/{sha}
 *
 * Commit statuses work with any PAT that has `repo` scope (classic) or
 * `commit statuses: write` (fine-grained). They appear identically to check
 * runs in the PR merge-requirement bar; the only difference is they don't
 * support the rich annotated text panel that check runs provide.
 *
 * State machine:  pending → success | failure | error
 * Statuses are identified by (sha + context); posting a new one with the same
 * context overwrites the previous — no ID bookkeeping needed.
 */

const STATUS_CONTEXT = "Cursor PR Review";

/*
 * Posted immediately when a job is accepted into the review queue.
 * Ensures developers see a GitHub status check the moment a PR is
 * opened — not only when a worker slot becomes available.
 */
export async function createQueuedStatus(
  octokit: Octokit,
  owner: string,
  repo: string,
  headSha: string
): Promise<void> {
  await octokit.repos.createCommitStatus({
    owner,
    repo,
    sha: headSha,
    state: "pending",
    context: STATUS_CONTEXT,
    description: "Queued for review",
  });

  logger.debug({ owner, repo }, "Posted queued commit status");
}

/*
 * Posted when the review queue is at capacity and cannot accept the job.
 * Uses state="error" so the PR merge bar turns red immediately and the
 * developer knows something is wrong rather than waiting indefinitely.
 */
/*
 * Posted when a fork PR is detected. Phase 1 does not review cross-repo heads;
 * this status makes the skip visible in the merge bar instead of silent logs only.
 */
export async function createSkippedStatus(
  octokit: Octokit,
  owner: string,
  repo: string,
  headSha: string,
  reason: string
): Promise<void> {
  await octokit.repos.createCommitStatus({
    owner,
    repo,
    sha: headSha,
    state: "success",
    context: STATUS_CONTEXT,
    description: `Review skipped: ${reason}`.slice(0, 140),
  });

  logger.info({ owner, repo, reason }, "Posted skipped commit status");
}

export async function createOverflowStatus(
  octokit: Octokit,
  owner: string,
  repo: string,
  headSha: string,
  reason: string
): Promise<void> {
  await octokit.repos.createCommitStatus({
    owner,
    repo,
    sha: headSha,
    state: "error",
    context: STATUS_CONTEXT,
    description: `Review rejected: ${reason}`.slice(0, 140),
  });

  logger.warn({ owner, repo, reason }, "Posted overflow commit status");
}

export async function createPendingStatus(
  octokit: Octokit,
  owner: string,
  repo: string,
  headSha: string
): Promise<void> {
  await octokit.repos.createCommitStatus({
    owner,
    repo,
    sha: headSha,
    state: "pending",
    context: STATUS_CONTEXT,
    description: "PR review in progress…",
  });

  logger.debug({ owner, repo }, "Created pending commit status");
}

export async function updateCommitStatus(
  octokit: Octokit,
  owner: string,
  repo: string,
  headSha: string,
  result: ReviewResult,
  blockOnFailure: boolean
): Promise<void> {
  const state: "success" | "failure" =
    blockOnFailure && result.shouldFail ? "failure" : "success";

  const issueCount = result.issues.length;
  const blockCount = result.gateSummary?.blockEligibleCount ?? 0;
  const raw =
    issueCount === 0
      ? "No issues found — looks good to merge"
      : blockCount > 0
      ? `${blockCount} block-eligible · ${issueCount} total · ${result.verdict.replace(
          "_",
          " "
        )}`
      : `${issueCount} issue(s) · verdict: ${result.verdict.replace("_", " ")}`;

  /*
   * GitHub truncates descriptions silently at 140 chars; slice here to be
   * explicit about what gets shown.
   */
  await octokit.repos.createCommitStatus({
    owner,
    repo,
    sha: headSha,
    state,
    context: STATUS_CONTEXT,
    description: raw.slice(0, 140),
  });

  logger.info(
    { owner, repo, state, verdict: result.verdict, issues: issueCount },
    "Updated commit status"
  );
}

export async function failCommitStatus(
  octokit: Octokit,
  owner: string,
  repo: string,
  headSha: string,
  errorMessage: string
): Promise<void> {
  try {
    await octokit.repos.createCommitStatus({
      owner,
      repo,
      sha: headSha,
      state: "error",
      context: STATUS_CONTEXT,
      description: `Review agent error: ${errorMessage}`.slice(0, 140),
    });
  } catch (err) {
    logger.error({ err }, "Failed to post error commit status");
  }
}
