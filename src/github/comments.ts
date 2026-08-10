import type { Octokit } from "@octokit/rest";
import type {
  LineComment,
  ReviewResult,
  Severity,
  ThreadContextBundle,
} from "../types.js";
import { logger } from "../utils/logger.js";

const BOT_COMMENT_MARKER = "<!-- cursor-pr-agent -->";

/*
 * Idempotency strategy:
 *   We tag every PR summary comment with the hidden BOT_COMMENT_MARKER. On
 *   re-runs (e.g. force-push to the PR head) we update the same comment
 *   instead of stacking duplicates.
 */
export async function upsertSummaryComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  result: ReviewResult
): Promise<void> {
  const body = buildSummaryBody(result);

  const existingId = await findExistingBotComment(
    octokit,
    owner,
    repo,
    prNumber
  );

  if (existingId) {
    await octokit.issues.updateComment({
      owner,
      repo,
      comment_id: existingId,
      body,
    });
    logger.debug(
      { owner, repo, prNumber, existingId },
      "Updated summary comment"
    );
    return;
  }

  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body,
  });
  logger.debug({ owner, repo, prNumber }, "Created summary comment");
}

/*
 * Inline line-level comments are posted as a single PR review with event="COMMENT"
 * so the bot never auto-approves or auto-rejects — the GitHub check run is the
 * sole merge gate.
 *
 * GitHub rejects the whole review if any single comment points at a line that
 * is outside the PR diff hunk. We pre-filter to comments on files known to be
 * in the PR; if that still fails, we fall back to posting each comment
 * individually and dropping the ones GitHub won't accept.
 */
export async function postInlineComments(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  issues: LineComment[],
  changedPaths: ReadonlySet<string>
): Promise<{ posted: number; dropped: number; deduplicated: number }> {
  const eligible = issues.filter(
    (i) => i.line > 0 && i.path.length > 0 && changedPaths.has(i.path)
  );

  if (eligible.length === 0) return { posted: 0, dropped: 0, deduplicated: 0 };

  /*
   * A GitHub API failure here must never lose a review - if we can't tell
   * what's already posted, we fall back to posting everything rather than
   * dropping findings.
   */
  let existing: { path: string; line: number }[] = [];
  try {
    existing = await fetchExistingBotComments(octokit, owner, repo, prNumber);
  } catch (err) {
    logger.warn(
      { err, owner, repo, prNumber },
      "Failed to fetch existing bot comments; posting without dedup"
    );
  }

  const { kept, droppedDuplicates } = dropDuplicateIssues(eligible, existing);

  if (kept.length === 0) {
    return { posted: 0, dropped: 0, deduplicated: droppedDuplicates };
  }

  const comments = kept.map((issue) => ({
    path: issue.path,
    line: issue.line,
    side: issue.side,
    body: formatInlineComment(issue),
  }));

  try {
    await octokit.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: headSha,
      event: "COMMENT",
      comments,
    });

    logger.info(
      { owner, repo, prNumber, count: comments.length },
      "Posted inline review comments"
    );
    return {
      posted: comments.length,
      dropped: 0,
      deduplicated: droppedDuplicates,
    };
  } catch (err) {
    logger.warn(
      { err, owner, repo, prNumber, count: comments.length },
      "Bulk inline review rejected; falling back to per-comment posts"
    );
    const fallback = await postCommentsIndividually(
      octokit,
      owner,
      repo,
      prNumber,
      headSha,
      kept
    );
    return { ...fallback, deduplicated: droppedDuplicates };
  }
}

/*
 * Fetch the PR's existing review comments authored by this bot, identified by
 * BOT_COMMENT_MARKER in the body. Used to dedup findings across re-runs.
 */
export async function fetchExistingBotComments(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<{ path: string; line: number }[]> {
  const result: { path: string; line: number }[] = [];

  for (let page = 1; ; page++) {
    const { data } = await octokit.pulls.listReviewComments({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
      page,
    });

    for (const comment of data) {
      if (!comment.body.includes(BOT_COMMENT_MARKER)) continue;
      result.push({
        path: comment.path,
        line: comment.line ?? comment.original_line ?? 0,
      });
    }

    if (data.length < 100) break;
  }

  return result;
}

/*
 * An issue is considered a duplicate of an existing bot comment when both
 * point at the same path and their lines are within 3 of each other - the
 * same tolerance suppressAcceptedThreadIssues uses, since diffs shift line
 * numbers slightly between pushes without changing the underlying finding.
 */
export function dropDuplicateIssues(
  issues: LineComment[],
  existing: { path: string; line: number }[]
): { kept: LineComment[]; droppedDuplicates: number } {
  const kept: LineComment[] = [];
  let droppedDuplicates = 0;

  for (const issue of issues) {
    const isDuplicate = existing.some(
      (e) => e.path === issue.path && Math.abs(e.line - issue.line) <= 3
    );
    if (isDuplicate) {
      droppedDuplicates += 1;
    } else {
      kept.push(issue);
    }
  }

  return { kept, droppedDuplicates };
}

async function postCommentsIndividually(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  issues: LineComment[]
): Promise<{ posted: number; dropped: number }> {
  let posted = 0;
  let dropped = 0;

  for (const issue of issues) {
    try {
      await octokit.pulls.createReviewComment({
        owner,
        repo,
        pull_number: prNumber,
        commit_id: headSha,
        path: issue.path,
        line: issue.line,
        side: issue.side,
        body: formatInlineComment(issue),
      });
      posted += 1;
    } catch {
      dropped += 1;
    }
  }

  logger.info(
    { owner, repo, prNumber, posted, dropped },
    "Per-comment fallback complete"
  );
  return { posted, dropped };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function findExistingBotComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<number | null> {
  const { data: comments } = await octokit.issues.listComments({
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  });

  const found = comments.find((c) => c.body?.includes(BOT_COMMENT_MARKER));
  return found?.id ?? null;
}

function verdictEmoji(verdict: ReviewResult["verdict"]): string {
  switch (verdict) {
    case "approve":
      return "✅";
    case "request_changes":
      return "🔴";
    case "comment":
      return "💬";
  }
}

function severityBadge(severity: Severity): string {
  switch (severity) {
    case "critical":
      return "🔴 **CRITICAL**";
    case "high":
      return "🟠 **HIGH**";
    case "medium":
      return "🟡 **MEDIUM**";
    case "low":
      return "🔵 **LOW**";
    case "info":
      return "ℹ️ **INFO**";
  }
}

function buildSummaryBody(result: ReviewResult): string {
  const emoji = verdictEmoji(result.verdict);
  const verdictLabel = capitalise(result.verdict.replace("_", " "));

  const humanReviewSection = buildNeedsHumanReviewSection(result.threadContext);
  const degradedNote = buildContextDegradedNote(result.threadContext);

  return `${BOT_COMMENT_MARKER}
## ${emoji} Cursor PR Review — ${verdictLabel}

${result.summary}
${humanReviewSection}${degradedNote}
---
<sub>Powered by <a href="https://cursor.com">Cursor SDK</a> · Push a new commit to re-run.</sub>
`;
}

/*
 * Renders a section for threads the agent classified as needs_human_review.
 * These are threads with human replies that lack convincing justification.
 * The section @mentions requested reviewers so GitHub routes a notification.
 */
function buildNeedsHumanReviewSection(
  bundle: ThreadContextBundle | undefined
): string {
  if (!bundle) return "";

  const threads = bundle.threads.filter(
    (t) => t.state === "needs_human_review"
  );
  if (threads.length === 0) return "";

  const mentionLine =
    bundle.requestedReviewers.length > 0
      ? `\n> cc ${bundle.requestedReviewers.map((r) => `@${r}`).join(" ")}`
      : "";

  const entries = threads.map(
    (t) =>
      `- [\`${t.path}:${t.line}\`] opened by @${
        t.commentAuthor
      }: "${t.originalBody.slice(0, 100)}${
        t.originalBody.length > 100 ? "…" : ""
      }"`
  );

  return `
### 👥 Threads Awaiting Human Decision

The following threads have replies but no clear justification for leaving the finding unresolved.
Please review and either resolve the thread or reply with \`#accepted-with-reason\` and an explanation.

${entries.join("\n")}
${mentionLine}
`;
}

/*
 * When thread context fetch failed in the orchestrator, threadContext is
 * undefined on ReviewResult. We surface this as a small footer note so
 * collaborators know the review ran without prior context.
 */
function buildContextDegradedNote(
  bundle: ThreadContextBundle | undefined
): string {
  if (bundle !== undefined) return "";
  return "\n> ⚠️ Prior review thread context was unavailable this run — accepted justifications were not applied.\n";
}

function formatInlineComment(issue: LineComment): string {
  return `${BOT_COMMENT_MARKER}\n${severityBadge(issue.severity)}\n\n${
    issue.body
  }`;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
