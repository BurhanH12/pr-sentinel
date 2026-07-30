import { Redis } from "ioredis";
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
import { buildPrKey, buildRunKey } from "./queue-keys.js";
import type { EnqueueOutcome, QueueStats } from "./queue-types.js";
import { metrics } from "../observability/metrics.js";

const QUEUE_KEY = "cursor-pr:jobs";
const RUNNING_KEY = "cursor-pr:running";
const PR_RUNNING_PREFIX = "cursor-pr:pr-running:";
const PR_QUEUED_PREFIX = "cursor-pr:pr-queued:";
const SUPERSEDED_SET = "cursor-pr:superseded";

let redisClient: Redis | null = null;

function getRedis(): Redis {
  if (!redisClient) {
    if (!env.REDIS_URL) {
      throw new Error("REDIS_URL is required when QUEUE_BACKEND=redis");
    }
    redisClient = new Redis(env.REDIS_URL);
  }
  return redisClient;
}

export class RedisReviewQueue {
  private readonly freshness = new InMemoryRunFreshnessChecker();

  async enqueueAsync(
    pr: PullRequestContext,
    triggerAction: TriggerAction
  ): Promise<EnqueueOutcome> {
    const redis = getRedis();
    const prKey = buildPrKey(pr);
    const runKey = buildRunKey(pr);
    const repoKey = `${pr.owner}/${pr.repo}`;

    const runningRunKey = await redis.get(`${PR_RUNNING_PREFIX}${prKey}`);
    if (runningRunKey === runKey) return "dedupe";

    const queuedRaw = await redis.get(`${PR_QUEUED_PREFIX}${prKey}`);
    if (queuedRaw) {
      const existing = JSON.parse(queuedRaw) as ReviewJob;
      if (existing.runKey === runKey) return "dedupe";
      const job = makeJob(pr, triggerAction, prKey, runKey);
      await redis.set(`${PR_QUEUED_PREFIX}${prKey}`, JSON.stringify(job));
      return "replaced";
    }

    if (runningRunKey) {
      await redis.sadd(SUPERSEDED_SET, runningRunKey);
      this.freshness.markSuperseded(runningRunKey);
    }

    const queueLen = await redis.llen(QUEUE_KEY);
    if (queueLen >= env.MAX_QUEUED_REVIEWS) {
      return "overflow";
    }

    const job = makeJob(pr, triggerAction, prKey, runKey);
    await redis.rpush(QUEUE_KEY, JSON.stringify({ ...job, repoKey }));
    await redis.set(`${PR_QUEUED_PREFIX}${prKey}`, JSON.stringify(job));
    return "accepted";
  }

  enqueue(
    pr: PullRequestContext,
    triggerAction: TriggerAction
  ): EnqueueOutcome {
    throw new Error("Use enqueueAsync for Redis backend");
  }

  getFreshnessChecker(): RunFreshnessChecker {
    const checker = this.freshness;
    return {
      isCurrentRun(runKey: string): boolean {
        return checker.isCurrentRun(runKey);
      },
    };
  }

  async statsAsync(): Promise<QueueStats> {
    const redis = getRedis();
    const totalQueued = await redis.llen(QUEUE_KEY);
    const runningKeys = await redis.keys(`${PR_RUNNING_PREFIX}*`);
    return {
      totalQueued,
      totalRunning: runningKeys.length,
      activeRepos: totalQueued + runningKeys.length,
    };
  }

  stats(): QueueStats {
    return { totalQueued: 0, totalRunning: 0, activeRepos: 0 };
  }

  drain(): void {
    void this.drainAsync();
  }

  private async drainAsync(): Promise<void> {
    const redis = getRedis();
    const running = await redis.keys(`${PR_RUNNING_PREFIX}*`);
    if (running.length >= env.MAX_CONCURRENT_REVIEWS) return;

    const raw = await redis.lpop(QUEUE_KEY);
    if (!raw) return;

    const job = JSON.parse(raw) as ReviewJob & { repoKey: string };
    await redis.del(`${PR_QUEUED_PREFIX}${job.prKey}`);
    await redis.set(`${PR_RUNNING_PREFIX}${job.prKey}`, job.runKey);
    await redis.incr(RUNNING_KEY);

    const waitMs = Date.now() - job.enqueuedAt;
    metrics.observe("queue_wait_ms", waitMs);

    const startedAt = Date.now();
    orchestratePRReview(job.pr, this.getFreshnessChecker())
      .then(() => {
        metrics.observe("agent_duration_ms", Date.now() - startedAt);
      })
      .catch((err: unknown) => {
        logger.error({ err }, "Redis worker review failed");
      })
      .finally(() => {
        void (async () => {
          await redis.del(`${PR_RUNNING_PREFIX}${job.prKey}`);
          await redis.decr(RUNNING_KEY);
          this.freshness.clearSuperseded(job.runKey);
          await this.drainAsync();
        })();
      });
  }
}

function makeJob(
  pr: PullRequestContext,
  triggerAction: TriggerAction,
  prKey: string,
  runKey: string
): ReviewJob {
  return { pr, triggerAction, enqueuedAt: Date.now(), prKey, runKey };
}

export async function enqueueReviewRedis(
  pr: PullRequestContext,
  triggerAction: TriggerAction
): Promise<void> {
  const queue = new RedisReviewQueue();
  const outcome = await queue.enqueueAsync(pr, triggerAction);
  metrics.increment(`enqueue_${outcome}`);

  const log = logger.child({
    repo: pr.repoFullName,
    pr: pr.prNumber,
    outcome,
  });

  if (outcome === "dedupe") return;

  const octokit = getOctokit();
  if (outcome === "overflow") {
    await createOverflowStatus(
      octokit,
      pr.owner,
      pr.repo,
      pr.headSha,
      "review queue at capacity"
    ).catch(() => undefined);
    return;
  }

  await createQueuedStatus(octokit, pr.owner, pr.repo, pr.headSha).catch(
    () => undefined
  );
  queue.drain();
}

export function createRedisWorkerLoop(): { stop: () => void } {
  const queue = new RedisReviewQueue();
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    queue.drain();
    setTimeout(() => void tick(), env.REVIEW_WORKER_POLL_MS);
  };

  void tick();
  return {
    stop: () => {
      stopped = true;
    },
  };
}
