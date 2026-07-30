import type { Octokit } from "@octokit/rest";
import type {
  ClassifiedThread,
  ThreadContextBundle,
  ThreadState,
} from "../types.js";
import { logger } from "../utils/logger.js";

/*
 * Thread context ingestion for same-PR conversation awareness.
 *
 * The orchestrator calls fetchThreadContext before running the Cursor agent so
 * the agent can be told about:
 *   - Threads where a collaborator has already justified leaving an issue
 *     unresolved (accepted_with_reason) — agent must not re-flag these as
 *     blocking.
 *   - Threads where a reply exists but provides no convincing justification
 *     (needs_human_review) — agent treats these as advisory and the summary
 *     surfaces reviewer @mentions.
 *
 * threads classified as needs_fix (no human engagement) are excluded from the
 * bundle: the agent handles them as normal open findings.
 */

/**
 * Marker that collaborators can place in a reply to explicitly accept an
 * unresolved finding with a stated reason.
 */
export const ACCEPTANCE_MARKER = "#accepted-with-reason";

/**
 * Natural-language patterns that signal a deliberate decision to leave an
 * issue unresolved. Used as a lower-confidence fallback when the explicit
 * marker is absent.
 */
export const JUSTIFICATION_PATTERNS: RegExp[] = [
  /\bby design\b/i,
  /\bintentional(?:ly)?\b/i,
  /\bacceptable\s+risk\b/i,
  /\bwon'?t\s+fix\b/i,
  /\bwontfix\b/i,
  /\bknown\s+issue\b/i,
  /\bdeferred?\b/i,
  /\bout\s+of\s+scope\b/i,
  /\btracked\s+separately\b/i,
  /\bbecause\s+\w.{10,}/i,
  /\bdue\s+to\s+\w.{5,}/i,
];

/**
 * Thin shape used during grouping before full ClassifiedThread is assembled.
 * Mirrors the subset of the Octokit response we care about.
 */
interface RawComment {
  id: number;
  in_reply_to_id?: number | null | undefined;
  path: string;
  line?: number | null | undefined;
  original_line?: number | null | undefined;
  body: string;
  user: { login: string } | null;
}

/**
 * Classify a single thread based on human reply bodies.
 *
 * Priority order:
 *   1. Explicit acceptance marker in any reply → accepted_with_reason.
 *   2. Justification language pattern in any reply → accepted_with_reason
 *      (lower confidence, still accepted to prioritise human intent).
 *   3. Human replies present but no justification language → needs_human_review.
 *   4. No human replies → needs_fix.
 */
export function classifyThread(humanReplyBodies: string[]): ThreadState {
  if (
    humanReplyBodies.some((b) =>
      b.toLowerCase().includes(ACCEPTANCE_MARKER.toLowerCase())
    )
  ) {
    return "accepted_with_reason";
  }

  if (
    humanReplyBodies.length > 0 &&
    humanReplyBodies.some((b) =>
      JUSTIFICATION_PATTERNS.some((pattern) => pattern.test(b))
    )
  ) {
    return "accepted_with_reason";
  }

  if (humanReplyBodies.length > 0) {
    return "needs_human_review";
  }

  return "needs_fix";
}

/**
 * Fetch all review comment threads for a PR, classify each one, and return
 * a bundle containing only threads relevant to agent behaviour.
 *
 * Graceful degradation: any error from this function is caught by the
 * orchestrator which continues the review without context.
 */
export async function fetchThreadContext(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  requestedReviewers: string[]
): Promise<ThreadContextBundle> {
  /*
   * Determine the bot's own login so we can exclude its replies when looking
   * for human justifications. Non-fatal if this call fails — we degrade to
   * treating all replies as human, which may cause minor over-classification.
   */
  let botLogin: string | null = null;
  try {
    const { data: viewer } = await octokit.users.getAuthenticated();
    botLogin = viewer.login;
  } catch {
    logger.warn(
      { owner, repo, prNumber },
      "Could not determine bot login for thread classification; treating all replies as human"
    );
  }

  const allComments: RawComment[] = [];
  for (let page = 1; ; page++) {
    const { data } = await octokit.pulls.listReviewComments({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
      page,
    });
    allComments.push(...(data as RawComment[]));
    if (data.length < 100) break;
  }

  /*
   * Group into threads: root comments (no in_reply_to_id) are thread heads;
   * replies point at their root. GitHub threads are always one level deep in
   * REST — replies never nest further.
   */
  const rootIndex = new Map<number, RawComment>();
  const humanReplyIndex = new Map<number, string[]>();

  for (const comment of allComments) {
    if (!comment.in_reply_to_id) {
      rootIndex.set(comment.id, comment);
      humanReplyIndex.set(comment.id, []);
    }
  }

  for (const comment of allComments) {
    if (comment.in_reply_to_id) {
      const rootId = comment.in_reply_to_id;
      const isHuman = comment.user?.login !== botLogin;
      if (rootIndex.has(rootId) && isHuman) {
        humanReplyIndex.get(rootId)?.push(comment.body);
      }
    }
  }

  const threads: ClassifiedThread[] = [];
  for (const [rootId, root] of rootIndex) {
    const replies = humanReplyIndex.get(rootId) ?? [];
    const state = classifyThread(replies);

    /*
     * Exclude needs_fix threads from the bundle: they are open findings with
     * no human engagement and the agent should surface them through its normal
     * review path without any special prompt guidance.
     */
    if (state === "needs_fix") continue;

    threads.push({
      threadId: rootId,
      path: root.path,
      /*
       * Prefer the adjusted line (post-force-push position) when available.
       * original_line is the position in the diff at the time the comment was
       * posted, which may no longer match the current file.
       */
      line: root.line ?? root.original_line ?? 0,
      originalBody: root.body,
      replyBodies: replies,
      state,
      commentAuthor: root.user?.login ?? "unknown",
    });
  }

  logger.debug(
    {
      owner,
      repo,
      prNumber,
      totalThreads: rootIndex.size,
      includedThreads: threads.length,
      accepted: threads.filter((t) => t.state === "accepted_with_reason")
        .length,
      needsHumanReview: threads.filter((t) => t.state === "needs_human_review")
        .length,
    },
    "Thread context classified"
  );

  return { threads, requestedReviewers };
}
