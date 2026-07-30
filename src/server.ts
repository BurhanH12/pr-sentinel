import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { Webhooks, createNodeMiddleware } from "@octokit/webhooks";
import type { PullRequestContext, TriggerAction } from "./types.js";
import { enqueueReview } from "./orchestration/queue.js";
import { getOctokit } from "./github/auth.js";
import { createSkippedStatus } from "./github/checks.js";
import { metrics } from "./observability/metrics.js";
import { reviewQueue } from "./orchestration/queue.js";
import { env } from "./env.js";
import { logger } from "./utils/logger.js";

const TRIGGER_ACTIONS = new Set<string>([
  "opened",
  "synchronize",
  "reopened",
  "ready_for_review",
]);

export function createServer(): express.Application {
  const app = express();

  const targetBranches = new Set(env.TARGET_BRANCHES);
  logger.info({ targetBranches: [...targetBranches] }, "Server starting");

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.get("/metrics", (_req, res) => {
    const stats = reviewQueue.stats();
    metrics.setGauge("queue_depth", stats.totalQueued);
    metrics.setGauge("queue_running", stats.totalRunning);
    metrics.setGauge("queue_active_repos", stats.activeRepos);
    res.json(metrics.snapshot());
  });

  const webhooks = new Webhooks({ secret: env.GITHUB_WEBHOOK_SECRET });

  /*
   * Log every verified webhook at info so local smee/GitHub forwarding is
   * visible without LOG_LEVEL=debug. Non-pull_request events (ping, push, …)
   * otherwise return 200 with no other output and look like a silent failure.
   */
  webhooks.onAny(({ id, name, payload }) => {
    const repo =
      payload && typeof payload === "object" && "repository" in payload
        ? (payload.repository as { full_name?: string } | null)?.full_name
        : undefined;
    const action =
      payload && typeof payload === "object" && "action" in payload
        ? (payload as { action?: string }).action
        : undefined;

    logger.info(
      { webhookId: id, event: name, action, repo },
      "GitHub webhook received"
    );
  });

  webhooks.on("pull_request", async ({ id, name, payload }) => {
    const action = payload.action;
    const baseBranch = payload.pull_request.base.ref.toLowerCase();

    const log = logger.child({
      webhookId: id,
      event: name,
      action,
      repo: payload.repository.full_name,
      pr: payload.number,
      base: baseBranch,
    });

    if (!TRIGGER_ACTIONS.has(action)) {
      log.info(
        { triggerActions: [...TRIGGER_ACTIONS] },
        "Ignoring pull_request — action does not trigger a review"
      );
      return;
    }

    if (!targetBranches.has(baseBranch)) {
      log.info(
        { baseBranch, targetBranches: [...targetBranches] },
        "Ignoring pull_request — base branch is not in TARGET_BRANCHES"
      );
      return;
    }

    if (payload.pull_request.draft) {
      log.info("Ignoring pull_request — PR is still a draft");
      return;
    }

    /*
     * Phase 1 scope guard: fork PRs have a different head repository than
     * the base repo. Reviewing them requires cloning and posting statuses
     * on the fork (head.repo), which is not yet implemented.
     *
     * We detect forks by comparing the head repo's full name against the
     * base repo. head.repo can be null when a contributor deletes their fork
     * after opening a PR — treat that as a fork and skip.
     */
    const headRepoFullName = payload.pull_request.head.repo?.full_name ?? null;
    const isForkPr =
      headRepoFullName === null ||
      headRepoFullName !== payload.repository.full_name;

    if (isForkPr) {
      log.info(
        { baseRepo: payload.repository.full_name, headRepo: headRepoFullName },
        "Skipping fork PR — cross-repo head/base support is not yet implemented"
      );
      const octokit = getOctokit();
      const headSha = payload.pull_request.head.sha;
      await createSkippedStatus(
        octokit,
        payload.repository.owner.login,
        payload.repository.name,
        headSha,
        "fork PRs unsupported"
      ).catch((err: unknown) =>
        log.warn({ err }, "Failed to post fork-skipped status")
      );
      return;
    }

    log.info("PR review triggered");

    const pr: PullRequestContext = {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      repoFullName: payload.repository.full_name,
      prNumber: payload.number,
      prTitle: payload.pull_request.title,
      prBody: payload.pull_request.body ?? "",
      baseBranch,
      headBranch: payload.pull_request.head.ref,
      headSha: payload.pull_request.head.sha,
      authorLogin: payload.pull_request.user?.login ?? "unknown",
      cloneUrl: payload.repository.clone_url,
      requestedReviewers: (payload.pull_request.requested_reviewers ?? [])
        .map((r: { login?: string } | null) => r?.login ?? "")
        .filter((login: string) => login.length > 0),
    };

    /*
     * GitHub expects a 2xx response within 10 seconds. enqueueReview posts
     * an immediate GitHub status and returns after adding the job to the
     * queue — the actual review runs asynchronously in the background.
     */
    enqueueReview(pr, action as TriggerAction).catch((err) => {
      log.error({ err }, "Unhandled error in enqueueReview");
    });
  });

  webhooks.on("pull_request", async ({ payload }) => {
    if (payload.action !== "closed" || !payload.pull_request.merged) {
      return;
    }
    const pr: PullRequestContext = {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      repoFullName: payload.repository.full_name,
      prNumber: payload.number,
      prTitle: payload.pull_request.title,
      prBody: payload.pull_request.body ?? "",
      baseBranch: payload.pull_request.base.ref.toLowerCase(),
      headBranch: payload.pull_request.head.ref,
      headSha:
        payload.pull_request.merge_commit_sha ?? payload.pull_request.head.sha,
      authorLogin: payload.pull_request.user?.login ?? "unknown",
      cloneUrl: payload.repository.clone_url,
      requestedReviewers: [],
    };
    const { recordMergeEvent } = await import("./learning/events.js");
    await recordMergeEvent(pr, pr.headSha).catch((err: unknown) => {
      logger.warn({ err }, "Failed to record merge learning event");
    });
  });

  webhooks.onError((error) => {
    logger.error(
      { error },
      "Webhook rejected — check GITHUB_WEBHOOK_SECRET matches the GitHub webhook UI"
    );
  });

  /*
   * Mount at root so Express does not strip the "/webhook" prefix before
   * createNodeMiddleware matches it. The middleware returns 404 for any
   * path that is not /webhook, so this does not interfere with /health.
   */
  app.use(createNodeMiddleware(webhooks, { path: "/webhook" }));

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err }, "Unhandled Express error");
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
