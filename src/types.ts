/*
 * Shared types for the PR review orchestrator.
 *
 * Two review shapes coexist:
 *   • ReviewRulesConfig — loaded per-PR by the config loader.
 *   • ReviewResult      — emitted by the agent runner and consumed by the
 *                         GitHub posters (comments + checks).
 *
 * The orchestrator deliberately runs ONE combined agent per PR (security
 * + performance + style in a single prompt) to keep cost predictable. The
 * old per-focus subagent fan-out has been removed.
 */

export interface ReviewRulesConfig {
  /** Human-readable rules passed verbatim into the agent prompt. */
  rules: string;

  /** Whether a failed review should block PR merge (sets check conclusion to "failure"). */
  blockOnFailure: boolean;

  /** Minimum severity that counts as a failure. */
  failureThreshold: Severity;

  /** Glob patterns excluded from the diff sent to the agent. */
  excludePatterns: string[];

  /** Hard cap on files reviewed in a single agent run. */
  maxFilesPerRun: number;

  /**
   * Focus areas mentioned in the prompt (purely a prompt-content knob — the
   * orchestrator still spins up only one agent). Defaults to
   * ["security", "performance", "style"].
   */
  focusAreas: string[];

  /** Path-scoped rule packs for monorepos (matched against changed file paths). */
  pathRules: PathRulePack[];
}

export interface PullRequestContext {
  owner: string;
  repo: string;
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  prBody: string;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  authorLogin: string;
  cloneUrl: string;
  /** GitHub logins of the PR's requested reviewers at the time of the webhook event. */
  requestedReviewers: string[];
}

/*
 * The subset of pull_request webhook actions that trigger a review.
 * Used for event-aware coalescing in the review queue.
 */
export type TriggerAction =
  | "opened"
  | "reopened"
  | "ready_for_review"
  | "synchronize";

/*
 * A unit of work in the review queue. Carries the PR context plus
 * queue bookkeeping fields so the scheduler can deduplicate and coalesce.
 */
export interface ReviewJob {
  pr: PullRequestContext;
  triggerAction: TriggerAction;
  /** Unix timestamp (Date.now()) when the job was first enqueued. */
  enqueuedAt: number;
  /** Stable PR identity key: "owner/repo#prNumber" */
  prKey: string;
  /** Run-specific key including SHA: "owner/repo#prNumber@headSha" */
  runKey: string;
}

export interface PullRequestFile {
  filename: string;
  status:
    | "added"
    | "modified"
    | "removed"
    | "renamed"
    | "copied"
    | "changed"
    | "unchanged";
  additions: number;
  deletions: number;
  patch?: string;
}

/**
 * Result of fetching and filtering PR files before the agent run.
 * When eligible files exceed maxFilesPerRun, only the first N are reviewed.
 */
export interface ReviewFileSelection {
  files: PullRequestFile[];
  /** Total changed files returned by GitHub before exclude globs. */
  totalFiles: number;
  /** Files removed by excludePatterns. */
  excludedCount: number;
  /** Eligible files not sent to the agent due to maxFilesPerRun. */
  truncatedCount: number;
  /** Sample of omitted paths (capped for summary display). */
  omittedFiles: string[];
  maxFiles: number;
}

export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type Verdict = "approve" | "request_changes" | "comment";

/**
 * Classification assigned to a PR review comment thread after reading
 * any human replies.
 *
 * - accepted_with_reason: A collaborator replied with an explicit marker or
 *   convincing justification. The agent should not re-flag this as blocking.
 * - needs_human_review: The thread has human replies but no clear justification,
 *   or the justification is ambiguous. A reviewer should make a judgment call.
 * - needs_fix: No human engagement at all — the finding is still open.
 */
export type ThreadState =
  | "accepted_with_reason"
  | "needs_human_review"
  | "needs_fix";

export interface ClassifiedThread {
  /** GitHub review comment ID of the root comment that started the thread. */
  threadId: number;
  /** File path the thread is anchored to. */
  path: string;
  /** Best-effort line number in the file (may drift after rebases). */
  line: number;
  /** Body of the root review comment. */
  originalBody: string;
  /** Bodies of human (non-bot) replies to the root comment. */
  replyBodies: string[];
  /** Computed thread state based on reply content. */
  state: ThreadState;
  /** GitHub login of the comment author who started the thread. */
  commentAuthor: string;
}

export interface ThreadContextBundle {
  /** All classified threads that warrant agent attention (excludes needs_fix). */
  threads: ClassifiedThread[];
  /** Requested reviewer GitHub logins extracted from the PR at webhook time. */
  requestedReviewers: string[];
}

export interface GateSummary {
  blockEligibleCount: number;
  advisoryCount: number;
}

export interface LineComment {
  path: string;
  line: number;
  side: "RIGHT" | "LEFT";
  body: string;
  severity: Severity;
}

export interface PathRulePack {
  /** Glob patterns; file must match at least one to apply this pack. */
  patterns: string[];
  /** Optional rules markdown appended when paths match. */
  rules?: string;
  focusAreas?: string[];
  /** Review skill folders under skills/ to inject when this pack matches. */
  skillRefs?: ReviewSkillRef[];
  failureThreshold?: Severity;
}

export type ReviewSkillRef =
  | "code-review-and-quality"
  | "nestjs-best-practices"
  | "security-best-practices"
  | "next-best-practices"
  | "vercel-react-best-practices";

export interface ReviewResult {
  verdict: Verdict;
  /** Markdown body for the top-level PR summary comment. */
  summary: string;
  issues: LineComment[];
  /** True if `issues` contains anything at or above the configured threshold. */
  shouldFail: boolean;
  /**
   * True when the review itself could not be completed (e.g. the model's
   * output failed to parse) - as opposed to a completed review that found
   * issues. Distinct from `shouldFail`: `shouldFail` says whether findings
   * should block a merge, `errored` says the tool never got a real answer.
   */
  errored?: boolean;
  /** Set when the PR had more reviewable files than maxFilesPerRun. */
  fileSelection?: ReviewFileSelection;
  gateSummary?: GateSummary;
  /** Count of agent issues suppressed because a human already accepted the thread. */
  suppressedAcceptedThreadCount?: number;
  /**
   * Thread context from the current PR run. Present when context was
   * successfully fetched; undefined when fetch was skipped or failed.
   * Used by comment formatters to surface needs_human_review threads with
   * reviewer mentions in the PR summary.
   */
  threadContext?: ThreadContextBundle;
}

/*
 * CheckRunIds removed: the GitHub Checks API requires GitHub App auth and
 * rejects PATs. We use commit statuses instead, which are identified by
 * (sha + context) — no ID bookkeeping is needed.
 */
