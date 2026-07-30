import type { PullRequestContext } from "../types.js";

export function buildPrKey(pr: PullRequestContext): string {
  return `${pr.owner}/${pr.repo}#${pr.prNumber}`;
}

export function buildRunKey(pr: PullRequestContext): string {
  return `${buildPrKey(pr)}@${pr.headSha}`;
}
