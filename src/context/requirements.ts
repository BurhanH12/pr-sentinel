import type { Octokit } from "@octokit/rest";
import type { PullRequestContext } from "../types.js";
import { logger } from "../utils/logger.js";

export interface RequirementContext {
  /** Markdown section for the agent prompt, or empty. */
  promptSection: string;
  linkedIssueNumbers: number[];
}

const ISSUE_REF = /\b(?:fixes|closes|resolves)\s+#(\d+)/gi;
const GITHUB_ISSUE_URL = /github\.com\/[^/]+\/[^/]+\/issues\/(\d+)/gi;

/**
 * Extract requirement context from PR title/body and linked GitHub issues.
 */
export async function fetchRequirementContext(
  octokit: Octokit,
  pr: PullRequestContext
): Promise<RequirementContext> {
  const text = `${pr.prTitle}\n${pr.prBody}`;
  const issueNumbers = new Set<number>();

  for (const match of text.matchAll(ISSUE_REF)) {
    const n = Number(match[1]);
    if (!Number.isNaN(n)) issueNumbers.add(n);
  }
  for (const match of text.matchAll(GITHUB_ISSUE_URL)) {
    const n = Number(match[1]);
    if (!Number.isNaN(n)) issueNumbers.add(n);
  }

  if (issueNumbers.size === 0) {
    return {
      promptSection:
        "\n> **Product context:** No linked ticket or issue was found in the PR title/body. Call out when missing context limits review confidence.\n",
      linkedIssueNumbers: [],
    };
  }

  const sections: string[] = ["", "## Linked requirements", ""];
  for (const num of issueNumbers) {
    try {
      const { data } = await octokit.issues.get({
        owner: pr.owner,
        repo: pr.repo,
        issue_number: num,
      });
      const bodyPreview = (data.body ?? "").slice(0, 800);
      sections.push(`### Issue #${num}: ${data.title}`);
      sections.push(bodyPreview || "_No description._");
      sections.push("");
    } catch (err) {
      logger.debug({ err, num }, "Could not fetch linked issue");
    }
  }

  return {
    promptSection: sections.join("\n"),
    linkedIssueNumbers: [...issueNumbers],
  };
}
