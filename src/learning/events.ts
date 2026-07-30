import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { PullRequestContext } from "../types.js";
import { env } from "../env.js";
import { logger } from "../utils/logger.js";

export interface MergeLearningEvent {
  type: "pr_merged";
  at: string;
  repoFullName: string;
  prNumber: number;
  mergeSha: string;
  headBranch: string;
}

export async function recordMergeEvent(
  pr: PullRequestContext,
  mergeSha: string
): Promise<void> {
  if (!env.REVIEW_LEARNING_ENABLED) return;

  const event: MergeLearningEvent = {
    type: "pr_merged",
    at: new Date().toISOString(),
    repoFullName: pr.repoFullName,
    prNumber: pr.prNumber,
    mergeSha,
    headBranch: pr.headBranch,
  };

  const path = env.REVIEW_LEARNING_PATH;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(event)}\n`, "utf-8");
  logger.info({ path, pr: pr.prNumber }, "Recorded merge learning event");
}
