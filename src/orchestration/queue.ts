import type { PullRequestContext, ReviewJob, TriggerAction } from "../types.js";
import { env } from "../env.js";
import { logger } from "../utils/logger.js";
import { orchestratePRReview } from "../orchestrator.js";
import { getOctokit } from "../github/auth.js";
import { createQueuedStatus, createOverflowStatus } from "../github/checks.js";
import {
  InMemoryRunFreshnessChecker,
  type RunFreshnessChecker,
} from "./stale-runs.js";
import { metrics } from "../observability/metrics.js";

export { buildPrKey, buildRunKey } from "./queue-keys.js";
import { buildPrKey, buildRunKey } from "./queue-keys.js";

/*
 * In-memory multi-repo review queue.
 *
 * Architecture:
 *   • One FIFO job lane per repository (keyed by "owner/repo").
 *   • A round-robin dispatcher rotates across non-empty lanes, picking one
 *     job per turn, to prevent a burst in one repo from starving others.
 *   • Global parallelism is bounded by MAX_CONCURRENT_REVIEWS.
 *   • Per-repo parallelism is bounded by MAX_ACTIVE_PER_REPO (default 1).
 *
 * Coalescing (event-aware dedupe):
 *   opened / reopened / ready_for_review
 *     – identical runKey queued/running → ignore (silent dedupe)
 *     – same prKey, different SHA, queued → replace queued job with newest SHA
 *   synchronize
 *     – same prKey queued → replace queued job with newest SHA
 *     – same prKey running → mark running as superseded + queue follow-up (or
 *       replace any already-queued follow-up with the newest SHA)
 *
 * Invariant: at most one running + one queued follow-up per prKey at any time.
 */
class ReviewQueue {
  /*
   * Per-repo FIFO job lanes. A repo's key is only present while it has
   * at least one queued job.
   */
  private readonly lanes = new Map<string, ReviewJob[]>();

  /*
   * Ever-increasing dispatch cursor. Mod'd by lane count on each drain
   * pass to advance round-robin without needing an index.
   */
  private rrCursor = 0;

  /** Total jobs currently running (calling orchestratePRReview). */
  private totalRunning = 0;

  /** Maps prKey → runKey for every currently running job. */
  private readonly runningByPrKey = new Map<string, string>();

  /** Maps repoKey → number of currently active (running) jobs for that repo. */
  private readonly activePerRepo = new Map<string, number>();

  private readonly freshness = new InMemoryRunFreshnessChecker();

  /** prKeys that currently have at least one job sitting in a lane. */
  private readonly queuedPrKeys = new Set<string>();

  private get maxConcurrent(): number {
    return env.MAX_CONCURRENT_REVIEWS;
  }

  private get maxPerRepo(): number {
    return env.MAX_ACTIVE_PER_REPO;
  }

  private get maxQueued(): number {
    return env.MAX_QUEUED_REVIEWS;
  }

  private totalQueued(): number {
    let n = 0;
    for (const lane of this.lanes.values()) n += lane.length;
    return n;
  }

  /*
   * Attempt to add a PR review job.
   *
   * Returns:
   *   "accepted"  — new job added to lane
   *   "dedupe"    — identical run already queued or running; silently dropped
   *   "replaced"  — an older job for the same PR was replaced with this SHA
   *   "overflow"  — queue at capacity and no displaceable job found; rejected
   */
  enqueue(
    pr: PullRequestContext,
    triggerAction: TriggerAction
  ): "accepted" | "dedupe" | "replaced" | "overflow" {
    const prKey = buildPrKey(pr);
    const runKey = buildRunKey(pr);
    const repoKey = `${pr.owner}/${pr.repo}`;

    // Running job with the exact same SHA: ignore
    if (this.runningByPrKey.get(prKey) === runKey) return "dedupe";

    // Same prKey already has a queued job: coalesce
    if (this.queuedPrKeys.has(prKey)) {
      const lane = this.lanes.get(repoKey);
      if (lane) {
        const idx = lane.findIndex((j) => j.prKey === prKey);
        if (idx >= 0) {
          const existing = lane[idx]!;
          if (existing.runKey === runKey) return "dedupe";
          lane[idx] = this.makeJob(pr, triggerAction, prKey, runKey);
          return "replaced";
        }
      }
    }

    // Running job for same prKey exists: mark it superseded, queue follow-up
    const currentRunKey = this.runningByPrKey.get(prKey);
    if (currentRunKey) {
      this.freshness.markSuperseded(currentRunKey);
      logger.debug(
        { prKey, supersededRunKey: currentRunKey },
        "Running review superseded by newer push"
      );
    }

    // Queue depth check: try to displace an older job for the same prKey first
    if (this.totalQueued() >= this.maxQueued) {
      const lane = this.lanes.get(repoKey);
      if (lane) {
        const idx = lane.findIndex((j) => j.prKey === prKey);
        if (idx >= 0) {
          lane[idx] = this.makeJob(pr, triggerAction, prKey, runKey);
          return "replaced";
        }
      }
      return "overflow";
    }

    // Add new job to the repo's lane
    let lane = this.lanes.get(repoKey);
    if (!lane) {
      lane = [];
      this.lanes.set(repoKey, lane);
    }
    lane.push(this.makeJob(pr, triggerAction, prKey, runKey));
    this.queuedPrKeys.add(prKey);
    return "accepted";
  }

  private makeJob(
    pr: PullRequestContext,
    triggerAction: TriggerAction,
    prKey: string,
    runKey: string
  ): ReviewJob {
    return { pr, triggerAction, enqueuedAt: Date.now(), prKey, runKey };
  }

  /*
   * Drain available worker slots using round-robin lane selection.
   *
   * Each drain pass walks lanes starting from the last-dispatched repo
   * (rrCursor) and picks the first lane that is not per-repo blocked.
   * This repeats until either MAX_CONCURRENT_REVIEWS is reached or no
   * dispatchable job remains (all pending lanes are per-repo blocked).
   */
  drain(): void {
    while (this.totalRunning < this.maxConcurrent) {
      const repoKeys = [...this.lanes.keys()];
      if (repoKeys.length === 0) break;

      const startIdx = this.rrCursor % repoKeys.length;
      let dispatched = false;

      for (let i = 0; i < repoKeys.length; i++) {
        const idx = (startIdx + i) % repoKeys.length;
        const repoKey = repoKeys[idx]!;
        const active = this.activePerRepo.get(repoKey) ?? 0;

        if (active >= this.maxPerRepo) continue;

        const lane = this.lanes.get(repoKey)!;
        const job = lane.shift()!;
        if (lane.length === 0) this.lanes.delete(repoKey);
        this.queuedPrKeys.delete(job.prKey);

        /*
         * Advance cursor past the dispatched repo so the next drain pass
         * starts from the following repo (fair round-robin).
         */
        this.rrCursor = idx + 1;
        this.runningByPrKey.set(job.prKey, job.runKey);
        this.activePerRepo.set(repoKey, active + 1);
        this.totalRunning++;

        this.startJob(job, repoKey);
        dispatched = true;
        break;
      }

      if (!dispatched) break;
    }
  }

  private startJob(job: ReviewJob, repoKey: string): void {
    const waitMs = Date.now() - job.enqueuedAt;
    const log = logger.child({
      repo: job.pr.repoFullName,
      pr: job.pr.prNumber,
      sha: job.pr.headSha.slice(0, 7),
      queueWaitMs: waitMs,
    });

    metrics.observe("queue_wait_ms", waitMs);
    log.info("Review job dispatched from queue");

    const startedAt = Date.now();

    orchestratePRReview(job.pr)
      .then(() => {
        const wasSuperseded = !this.freshness.isCurrentRun(job.runKey);
        const agentDurationMs = Date.now() - startedAt;
        metrics.observe("agent_duration_ms", agentDurationMs);
        if (wasSuperseded) {
          metrics.increment("review_completed_superseded");
        }
        log.info({ agentDurationMs, wasSuperseded }, "Review job completed");
      })
      .catch((err: unknown) => {
        log.error({ err }, "Review job failed");
      })
      .finally(() => {
        this.freshness.clearSuperseded(job.runKey);
        this.runningByPrKey.delete(job.prKey);
        const active = this.activePerRepo.get(repoKey) ?? 1;
        this.activePerRepo.set(repoKey, Math.max(0, active - 1));
        this.totalRunning = Math.max(0, this.totalRunning - 1);
        // Start the next available job now that a slot freed up
        this.drain();
      });
  }

  getFreshnessChecker(): RunFreshnessChecker {
    return this.freshness;
  }

  stats(): { totalQueued: number; totalRunning: number; activeRepos: number } {
    return {
      totalQueued: this.totalQueued(),
      totalRunning: this.totalRunning,
      /*
       * Repos with either a running or queued job. Used for observability
       * only — not a hard limit.
       */
      activeRepos: this.runningByPrKey.size + this.lanes.size,
    };
  }
}

export const reviewQueue = new ReviewQueue();

/** Freshness checker for the in-memory queue (used before publishing GitHub output). */
export function getRunFreshnessChecker(): RunFreshnessChecker {
  return reviewQueue.getFreshnessChecker();
}

/*
 * Public entry point for webhook handlers.
 *
 * Posts an immediate "Queued for review" GitHub commit status so developers
 * see feedback right away, adds the job to the queue, then drains any
 * available worker slots.
 */
export async function enqueueReview(
  pr: PullRequestContext,
  triggerAction: TriggerAction
): Promise<void> {
  const { env } = await import("../env.js");
  if (env.QUEUE_BACKEND === "redis") {
    const { enqueueReviewRedis } = await import("./redis-queue.js");
    return enqueueReviewRedis(pr, triggerAction);
  }

  const prKey = buildPrKey(pr);
  const outcome = reviewQueue.enqueue(pr, triggerAction);
  metrics.increment(`enqueue_${outcome}`);

  const log = logger.child({
    repo: pr.repoFullName,
    pr: pr.prNumber,
    sha: pr.headSha.slice(0, 7),
    triggerAction,
    outcome,
  });

  if (outcome === "dedupe") {
    log.debug(
      { prKey },
      "Review deduplicated — same SHA already queued or running"
    );
    return;
  }

  const octokit = getOctokit();

  if (outcome === "overflow") {
    log.warn({ prKey }, "Review queue at capacity — job rejected");
    await createOverflowStatus(
      octokit,
      pr.owner,
      pr.repo,
      pr.headSha,
      "review queue at capacity"
    ).catch((err: unknown) =>
      log.error({ err }, "Failed to post overflow status")
    );
    return;
  }

  log.info({ prKey }, `Review ${outcome} — posting queued status`);

  /*
   * Post the "queued" status before draining so the developer sees a check
   * status appear even if all worker slots are occupied by other repos.
   */
  await createQueuedStatus(octokit, pr.owner, pr.repo, pr.headSha).catch(
    (err: unknown) => log.warn({ err }, "Failed to post queued status")
  );

  const stats = reviewQueue.stats();
  log.debug(stats, "Queue stats after enqueue");

  reviewQueue.drain();
}
