import type { PullRequestContext, ReviewJob, TriggerAction } from "../types.js";

export type EnqueueOutcome = "accepted" | "dedupe" | "replaced" | "overflow";

export interface QueueStats {
  totalQueued: number;
  totalRunning: number;
  activeRepos: number;
}

export interface ReviewQueueBackend {
  enqueue(pr: PullRequestContext, triggerAction: TriggerAction): EnqueueOutcome;
  drain(): void;
  stats(): QueueStats;
  getFreshnessChecker(): import("./stale-runs.js").RunFreshnessChecker;
}

export type { ReviewJob, TriggerAction };
