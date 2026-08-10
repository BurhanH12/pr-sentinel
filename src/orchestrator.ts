import type { PullRequestContext, ThreadContextBundle } from "./types.js";
import { getOctokit } from "./github/auth.js";
import { cloneRepoAtSha } from "./github/clone.js";
import {
  createPendingStatus,
  failCommitStatus,
  updateCommitStatus,
} from "./github/checks.js";
import { postInlineComments, upsertSummaryComment } from "./github/comments.js";
import { changedPathSet, fetchPRFiles } from "./github/diff.js";
import { fetchThreadContext } from "./github/review-context.js";
import { loadReviewConfig } from "./config/loader.js";
import { fetchRequirementContext } from "./context/requirements.js";
import { runPRReview } from "./agent/runner.js";
import { buildRunKey, getRunFreshnessChecker } from "./orchestration/queue.js";
import { logger } from "./utils/logger.js";
import { metrics } from "./observability/metrics.js";

/*
 * End-to-end orchestration for a single PR review run.
 *
 * Webhook handler invokes this fire-and-forget. The function MUST NOT
 * re-throw into the HTTP response path. All failures surface as an "error"
 * commit status on the PR so the developer always gets feedback.
 *
 * Pipeline:
 *   1. Load layered review config.
 *   2. Post a "pending" commit status immediately.
 *   3. Fetch PR file list + filter excluded patterns.
 *   4. Shallow-clone the PR head SHA into a temp dir.
 *   5. Run a single combined Cursor agent (local runtime).
 *   6. Post / upsert the PR summary comment.
 *   7. Post inline line-level comments.
 *   8. Update commit status to success / failure.
 *   9. Always cleanup the temp clone.
 */
export async function orchestratePRReview(
  pr: PullRequestContext,
  freshnessChecker = getRunFreshnessChecker()
): Promise<void> {
  const runKey = buildRunKey(pr);

  const isStale = async (): Promise<boolean> =>
    !freshnessChecker.isCurrentRun(runKey);
  const log = logger.child({
    repo: pr.repoFullName,
    pr: pr.prNumber,
    sha: pr.headSha.slice(0, 7),
  });

  log.info("Orchestration started");

  const octokit = getOctokit();
  const config = await loadReviewConfig(octokit, pr.owner, pr.repo);

  log.info(
    {
      focusAreas: config.focusAreas,
      blockOnFailure: config.blockOnFailure,
      threshold: config.failureThreshold,
    },
    "Config loaded"
  );

  await createPendingStatus(octokit, pr.owner, pr.repo, pr.headSha);

  let cleanup: (() => Promise<void>) | null = null;

  try {
    const fileSelection = await fetchPRFiles(
      octokit,
      pr.owner,
      pr.repo,
      pr.prNumber,
      config.excludePatterns,
      config.maxFilesPerRun
    );

    if (fileSelection.files.length === 0) {
      log.info("No reviewable files after filtering — skipping agent run");
      await updateCommitStatus(
        octokit,
        pr.owner,
        pr.repo,
        pr.headSha,
        {
          verdict: "approve",
          summary: "No reviewable files changed in this PR.",
          issues: [],
          shouldFail: false,
        },
        config.blockOnFailure
      );
      return;
    }

    if (fileSelection.truncatedCount > 0) {
      metrics.increment("partial_reviews");
    }
    log.info(
      {
        files: fileSelection.files.length,
        truncated: fileSelection.truncatedCount,
      },
      "Files ready for review"
    );

    /*
     * Fetch same-PR thread context before cloning so the agent knows which
     * findings have already been justified by collaborators. Failure is
     * non-fatal — the review continues without context and a note is added
     * to the summary by upsertSummaryComment.
     */
    let threadContext: ThreadContextBundle | undefined;
    try {
      threadContext = await fetchThreadContext(
        octokit,
        pr.owner,
        pr.repo,
        pr.prNumber,
        pr.requestedReviewers
      );
      log.info(
        {
          threads: threadContext.threads.length,
          reviewers: threadContext.requestedReviewers.length,
        },
        "Thread context fetched"
      );
    } catch (err) {
      log.warn(
        { err },
        "Thread context fetch failed — continuing without context"
      );
    }

    const cloneStart = Date.now();
    const cloned = await cloneRepoAtSha(
      pr.owner,
      pr.repo,
      pr.headSha,
      pr.prNumber
    );
    cleanup = cloned.cleanup;
    log.info(
      { cloneDurationMs: Date.now() - cloneStart },
      "Repo checkout ready"
    );

    let requirementSection = "";
    try {
      const reqCtx = await fetchRequirementContext(octokit, pr);
      requirementSection = reqCtx.promptSection;
    } catch (err) {
      log.warn({ err }, "Requirement context fetch failed");
    }

    const agentStart = Date.now();
    const reviewResult = await runPRReview(
      pr,
      fileSelection,
      config,
      cloned.cwd,
      threadContext,
      requirementSection
    );
    log.info(
      {
        agentDurationMs: Date.now() - agentStart,
        verdict: reviewResult.verdict,
      },
      "Agent run complete"
    );

    if (await isStale()) {
      log.info({ runKey }, "Skipping GitHub publish — superseded by newer SHA");
      metrics.increment("stale_publish_suppressed");
      return;
    }

    await upsertSummaryComment(
      octokit,
      pr.owner,
      pr.repo,
      pr.prNumber,
      reviewResult
    );

    const inlineStats = await postInlineComments(
      octokit,
      pr.owner,
      pr.repo,
      pr.prNumber,
      pr.headSha,
      reviewResult.issues,
      changedPathSet(fileSelection.files)
    );
    metrics.recordInlineComments(
      inlineStats.posted,
      inlineStats.dropped,
      inlineStats.deduplicated
    );

    if (await isStale()) {
      log.info(
        { runKey },
        "Skipping final status — superseded after inline post"
      );
      metrics.increment("stale_publish_suppressed");
      return;
    }

    await updateCommitStatus(
      octokit,
      pr.owner,
      pr.repo,
      pr.headSha,
      reviewResult,
      config.blockOnFailure
    );

    log.info(
      {
        verdict: reviewResult.verdict,
        issues: reviewResult.issues.length,
        shouldFail: reviewResult.shouldFail,
        blocked: config.blockOnFailure && reviewResult.shouldFail,
      },
      "Orchestration complete"
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Orchestration failed");
    await failCommitStatus(octokit, pr.owner, pr.repo, pr.headSha, message);
    throw err;
  } finally {
    if (cleanup) {
      await cleanup();
    }
  }
}
