import { CursorAgentError } from "@cursor/sdk";
import { z } from "zod";
import { computeShouldFail, SEVERITY_RANK } from "./gating.js";
import { promptAgentWithRetry } from "./cursor-invoke.js";
import { buildExemplarSection } from "./exemplars.js";
import { buildRuntimeKnowledgeSection } from "./runtime-knowledge.js";
import { resolveMatchingPathRules } from "../config/loader.js";
import type {
  ClassifiedThread,
  LineComment,
  PullRequestContext,
  ReviewFileSelection,
  ReviewResult,
  ReviewRulesConfig,
  Severity,
  ThreadContextBundle,
  Verdict,
} from "../types.js";
import { env } from "../env.js";
import { logger } from "../utils/logger.js";
import { formatDiffForPrompt } from "../github/diff.js";
import { metrics } from "../observability/metrics.js";
import { cacheHitRate, estimateCostUsd } from "../observability/cost.js";

/*
 * Zod schema for the JSON the Cursor agent is asked to return.
 *
 * The schema doubles as runtime validation AND inline documentation of the
 * contract — keep this and the prompt in §buildReviewPrompt synchronised.
 */
const lineCommentSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive(),
  side: z.enum(["RIGHT", "LEFT"]).default("RIGHT"),
  severity: z.enum(["critical", "high", "medium", "low", "info"]),
  body: z.string().min(1),
});

/*
 * The array itself is unbounded at parse time. The model is told "maximum 10
 * issues" in the prompt, but a zod `.max()` here would make an 11-issue
 * overshoot fail `safeParse` for the *whole* object — silently discarding a
 * real, otherwise-good review down to zero issues. Overshoot is handled
 * after a successful parse instead, by `truncateIssuesToTop` below.
 */
export const agentOutputSchema = z.object({
  verdict: z.enum(["approve", "request_changes", "comment"]),
  summary: z.string().min(1),
  checked: z.array(z.string().min(1)).default([]),
  issues: z.array(lineCommentSchema).default([]),
});

export type AgentOutput = z.infer<typeof agentOutputSchema>;

const ISSUES_CAP = 10;
const CHECKED_CAP = 6;

/*
 * Enforce the 10-issue cap post-parse: sort by severity (critical highest),
 * stable within a severity band so ties keep the model's original order,
 * then keep the top `cap`. Pure and exported so it is unit-testable without
 * invoking the model.
 */
export function truncateIssuesToTop(
  issues: LineComment[],
  cap = ISSUES_CAP
): { issues: LineComment[]; droppedCount: number } {
  if (issues.length <= cap) {
    return { issues, droppedCount: 0 };
  }

  const ranked = issues
    .map((issue, index) => ({ issue, index }))
    .sort((a, b) => {
      const rankDiff = SEVERITY_RANK[b.issue.severity] - SEVERITY_RANK[a.issue.severity];
      return rankDiff !== 0 ? rankDiff : a.index - b.index;
    });

  return {
    issues: ranked.slice(0, cap).map((entry) => entry.issue),
    droppedCount: issues.length - cap,
  };
}

/*
 * Same rationale as `truncateIssuesToTop`: `checked` is unbounded at parse
 * time (the prompt asks for "3 to 6 entries", but a zod `.max()` would fail
 * `safeParse` for the whole object on a 7-entry overshoot). Enforce the cap
 * post-parse by keeping the model's first `cap` entries - there is no
 * severity to rank by here, so no sort is needed, unlike issues.
 */
export function truncateCheckedToTop(
  checked: string[],
  cap = CHECKED_CAP
): string[] {
  return checked.length <= cap ? checked : checked.slice(0, cap);
}

/*
 * Run a single combined PR review against a local checkout of the PR head SHA.
 *
 * `cwd` is the path returned by github/clone.ts. The Cursor SDK runs in
 * `local` runtime against that directory, so the agent can read the actual
 * file tree (not just the diff) when forming its conclusions.
 */
export async function runPRReview(
  pr: PullRequestContext,
  fileSelection: ReviewFileSelection,
  config: ReviewRulesConfig,
  cwd: string,
  threadContext?: ThreadContextBundle,
  requirementSection = ""
): Promise<ReviewResult> {
  const log = logger.child({
    repo: pr.repoFullName,
    pr: pr.prNumber,
    model: env.CURSOR_MODEL,
  });

  const changedPaths = fileSelection.files.map((f) => f.filename);
  const matchingPathRules = resolveMatchingPathRules(config, changedPaths);
  const runtimeKnowledgeSection = await buildRuntimeKnowledgeSection(
    cwd,
    changedPaths,
    matchingPathRules
  );
  const exemplarSection = await buildExemplarSection(
    cwd,
    fileSelection.files,
    fileSelection.allChangedPaths
  );
  const diff = formatDiffForPrompt(fileSelection.files);
  const prompt = buildReviewPrompt(
    pr,
    diff,
    config,
    threadContext,
    matchingPathRules,
    requirementSection,
    runtimeKnowledgeSection,
    exemplarSection
  );

  log.info({ files: fileSelection.files.length }, "Invoking Cursor agent");

  let raw: string;
  let runCost: ReviewResult["runCost"];
  const runStartedAt = Date.now();
  try {
    const result = await promptAgentWithRetry(prompt, {
      apiKey: env.CURSOR_API_KEY,
      model: {
        id: env.CURSOR_MODEL,
        params: [{ id: "thinking", value: env.CURSOR_THINKING }],
      },
      local: { cwd },
    });

    if (result.status !== "finished") {
      throw new Error(
        `Cursor agent ended with status="${result.status}" (run id=${result.id})`
      );
    }

    raw = result.result ?? "";

    /*
     * Fall back to a wall-clock measurement when the SDK omits durationMs -
     * the run still consumed time (and money) even if the SDK didn't report
     * it. metrics.recordAgentRun is called exactly once here, before parsing
     * branches into the success/parse-failure paths below, so a parse
     * failure - which still cost tokens - is still recorded.
     */
    const durationMs = result.durationMs ?? Date.now() - runStartedAt;
    const usage = result.usage ?? {};
    metrics.recordAgentRun(usage, env.CURSOR_MODEL, durationMs);

    if (result.usage) {
      const estimatedCostUsd = estimateCostUsd(result.usage, env.CURSOR_MODEL);
      const hitRate = cacheHitRate(result.usage);
      runCost = {
        usage: result.usage,
        estimatedCostUsd,
        cacheHitRate: hitRate,
        durationMs,
      };
      log.info(
        {
          runId: result.id,
          durationMs,
          chars: raw.length,
          tokens: result.usage.totalTokens,
          estimatedCostUsd,
          cacheHitRate: hitRate,
        },
        "Cursor agent finished"
      );
    } else {
      log.info(
        { runId: result.id, durationMs, chars: raw.length },
        "Cursor agent finished (usage missing)"
      );
    }
  } catch (err) {
    if (err instanceof CursorAgentError) {
      log.error(
        { err, code: err.code, retryable: err.isRetryable },
        "Cursor SDK failed to start agent"
      );
    } else {
      log.error({ err }, "Cursor agent run failed");
    }
    throw err;
  }

  const outcome = parseAgentOutput(raw);
  if (!outcome.ok) {
    return { ...buildParseFailureResult(outcome, raw), runCost };
  }
  const effectiveFocusAreas = resolveEffectiveFocusAreas(config, matchingPathRules);
  return {
    ...finaliseResult(
      outcome.output,
      config,
      threadContext,
      fileSelection,
      effectiveFocusAreas
    ),
    runCost,
  };
}

// ─── Prompt builder ──────────────────────────────────────────────────────────

export function buildReviewPrompt(
  pr: PullRequestContext,
  diff: string,
  config: ReviewRulesConfig,
  threadContext?: ThreadContextBundle,
  matchingPathRules: ReviewRulesConfig["pathRules"] = [],
  requirementSection = "",
  runtimeKnowledgeSection = "",
  exemplarSection = ""
): string {
  const focusAreas = resolveEffectiveFocusAreas(config, matchingPathRules);
  const focusList = focusAreas
    .map((f, idx) => `${idx + 1}. **${f}**`)
    .join("\n");

  const threadContextSection = buildThreadContextSection(threadContext);
  const pathRulesSection = buildPathRulesSection(matchingPathRules);

  /*
   * Cursor prompt caching is prefix-based. Everything above the "PR under
   * review" heading depends only on repo config and the changed-path set, so
   * it is byte-identical across PRs and cacheable. Anything PR-specific
   * (identity, requirements, threads, diff) must stay in the tail. New
   * optional volatile sections go in the tail array, after PR identity and
   * before requirements.
   */
  const stablePrefix = `You are a senior staff engineer doing a thorough pull request review.

The base branch represents the current project architecture - your job is to make sure the PR is
consistent with it and follows the rules below.

## Focus areas

Cover all of these in a single combined review:
${focusList}

## Project review rules

${config.rules}
${pathRulesSection}${runtimeKnowledgeSection}
---

## Your task

Read the rules and the diff carefully. You also have read access to the entire repository
working copy in your local runtime — feel free to open any file to understand context before
deciding whether something is a real issue.

Then return ONLY a JSON object with this exact shape — no prose, no markdown fences, no preamble:

\`\`\`
{
  "verdict": "approve" | "comment" | "request_changes",
  "summary": "<2-5 sentence plain-text summary spanning all focus areas>",
  "checked": ["<short past-tense statement of something you actually verified>", ...],
  "issues": [
    {
      "path": "<file path relative to repo root>",
      "line": <positive integer — line number in the NEW file (right side of diff)>,
      "side": "RIGHT" | "LEFT",
      "severity": "critical" | "high" | "medium" | "low" | "info",
      "body": "<concise, actionable explanation of the issue and how to fix it>"
    }
  ]
}
\`\`\`

Output rules:
- "checked" is REQUIRED, even when no issues are found - especially then. Provide 3 to 6 entries,
  each a short past-tense statement naming a concrete artefact from this PR (a file, a function, a
  call site, a convention compared against). Never write something generic like "reviewed the
  code" - "traced the 3 new exports in \`src/queue.ts\` to their 7 call sites" is the bar.
- "issues" MUST be an empty array \`[]\` if nothing was found — never omit it.
- "verdict" = "approve" when no issues, "comment" for low/info only, "request_changes" otherwise.
- Do NOT invent issues. Only flag what you can point at in the diff or files.
- Maximum 10 issues total. If you find more, report only the 10 highest-severity ones - a review that reports twenty speculative findings around one real one has failed.
- Keep "body" actionable — name the fix, don't just describe the smell.
`;

  const prIdentity = `## PR under review

You are reviewing PR #${pr.prNumber} in \`${
    pr.repoFullName
  }\` against base branch \`${pr.baseBranch}\`.

**PR title:** ${pr.prTitle}
**Author:** ${pr.authorLogin}
${pr.prBody ? `**Description:**\n${pr.prBody}\n` : ""}`;

  const tail = [
    prIdentity,
    exemplarSection,
    requirementSection,
    threadContextSection,
    `## Changed files (unified diff)\n\n${diff}`,
    "Reminder: reply with ONLY the JSON object described above.",
  ];

  return `${stablePrefix}\n${tail.join("\n")}\n`;
}

function resolveEffectiveFocusAreas(
  config: ReviewRulesConfig,
  matchingPathRules: ReviewRulesConfig["pathRules"]
): string[] {
  const focusAreas = new Set(config.focusAreas);
  for (const pack of matchingPathRules) {
    for (const area of pack.focusAreas ?? []) focusAreas.add(area);
  }
  return [...focusAreas];
}

/*
 * Build the optional "Prior review thread context" section injected into the
 * prompt. Tells the agent about threads where collaborators have already
 * made a decision so it does not repeat the same findings as blocking issues.
 */
function buildPathRulesSection(packs: ReviewRulesConfig["pathRules"]): string {
  if (packs.length === 0) return "";
  const lines: string[] = ["", "## Path-specific rules", ""];
  for (const pack of packs) {
    lines.push(`### Patterns: ${pack.patterns.join(", ")}`);
    if (pack.focusAreas?.length) {
      lines.push(`Focus: ${pack.focusAreas.join(", ")}`);
    }
    if (pack.rules) {
      lines.push(pack.rules);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function buildThreadContextSection(
  threadContext?: ThreadContextBundle
): string {
  if (!threadContext || threadContext.threads.length === 0) return "";

  const accepted = threadContext.threads.filter(
    (t) => t.state === "accepted_with_reason"
  );
  const needsHuman = threadContext.threads.filter(
    (t) => t.state === "needs_human_review"
  );

  if (accepted.length === 0 && needsHuman.length === 0) return "";

  const lines: string[] = [
    "",
    "## Prior review thread context",
    "",
    "The following threads from earlier review runs have human responses. Follow the behaviour rules below exactly.",
    "",
  ];

  if (accepted.length > 0) {
    lines.push(
      "### Accepted findings (do NOT re-flag as blocking)",
      "",
      "A collaborator has replied with a clear justification for leaving these unresolved.",
      "You MUST NOT raise these as `critical`, `high`, or `medium` issues.",
      "You may mention them at `info` severity at most, only if directly relevant to a new finding.",
      ""
    );
    for (const t of accepted) {
      lines.push(formatThreadEntry(t));
    }
    lines.push("");
  }

  if (needsHuman.length > 0) {
    lines.push(
      "### Threads needing human decision (treat as advisory, not blocking)",
      "",
      "These threads have human replies but the justification is ambiguous or incomplete.",
      "If you still see the same issue in the diff, flag it at `low` or `info` severity only.",
      "Do NOT emit `critical`, `high`, or `medium` for these specific thread locations.",
      ""
    );
    for (const t of needsHuman) {
      lines.push(formatThreadEntry(t));
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatThreadEntry(t: ClassifiedThread): string {
  const replyPreview =
    t.replyBodies.length > 0
      ? `Reply: "${t.replyBodies[0]!.slice(0, 120)}${
          t.replyBodies[0]!.length > 120 ? "…" : ""
        }"`
      : "No reply.";
  return `- \`${t.path}:${t.line}\` (by @${
    t.commentAuthor
  }): "${t.originalBody.slice(0, 120)}${
    t.originalBody.length > 120 ? "…" : ""
  }" | ${replyPreview}`;
}

// ─── Output parsing ──────────────────────────────────────────────────────────

/*
 * Explicit parse outcome instead of a silent degrade. A parse failure must
 * be distinguishable from "the model reviewed the PR and found nothing" -
 * conflating the two turns a broken agent response into a green status.
 */
export type ParseOutcome =
  | { ok: true; output: AgentOutput }
  | {
      ok: false;
      reason: "no_json" | "invalid_json" | "schema_mismatch";
      detail: string;
    };

export function parseAgentOutput(raw: string): ParseOutcome {
  /*
   * Models occasionally wrap JSON in ```json fences despite instructions, or
   * prepend a sentence. Strip both, then take the outermost {...} block.
   */
  const stripped = raw
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    logger.warn(
      { preview: raw.slice(0, 200) },
      "Agent output contained no JSON block"
    );
    return {
      ok: false,
      reason: "no_json",
      detail: "No `{...}` JSON object was found in the agent output.",
    };
  }

  const candidate = stripped.slice(start, end + 1);
  let json: unknown;
  try {
    json = JSON.parse(candidate);
  } catch (err) {
    logger.warn(
      { err, preview: candidate.slice(0, 200) },
      "Agent output was not valid JSON"
    );
    return {
      ok: false,
      reason: "invalid_json",
      detail: err instanceof Error ? err.message : "JSON.parse failed.",
    };
  }

  const parsed = agentOutputSchema.safeParse(json);
  if (!parsed.success) {
    logger.warn(
      { issues: parsed.error.issues, preview: candidate.slice(0, 200) },
      "Agent JSON failed schema validation"
    );
    const zodDetail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    /*
     * A schema-mismatch response sometimes still carries a usable "summary"
     * string from the model. Fold it into the failure detail so a human can
     * see it - it must never be promoted into a successful result.
     */
    const fallback = json as { summary?: unknown };
    const salvagedSummary =
      typeof fallback.summary === "string" && fallback.summary.length > 0
        ? fallback.summary
        : undefined;
    return {
      ok: false,
      reason: "schema_mismatch",
      detail: salvagedSummary
        ? `${zodDetail} (agent-provided summary: "${salvagedSummary.slice(0, 200)}")`
        : zodDetail,
    };
  }

  const { issues, droppedCount } = truncateIssuesToTop(parsed.data.issues);
  if (droppedCount > 0) {
    logger.warn(
      { total: parsed.data.issues.length, droppedCount, cap: ISSUES_CAP },
      "Agent overshot the issues cap; dropped the lowest-severity excess"
    );
    metrics.increment("agent_issues_overshoot_dropped", droppedCount);
  }

  const checked = truncateCheckedToTop(parsed.data.checked);

  return { ok: true, output: { ...parsed.data, issues, checked } };
}

/*
 * Build a fail-closed ReviewResult for a parse failure. Bypasses
 * finaliseResult on purpose: that path runs normaliseVerdict, which turns an
 * empty issue list into verdict "approve" - exactly the green-status-on-broken-
 * response outcome this task exists to prevent.
 */
export function buildParseFailureResult(
  outcome: Extract<ParseOutcome, { ok: false }>,
  raw: string
): ReviewResult {
  metrics.increment("agent_output_parse_failures");

  const preview = neutralisePreviewFences(raw.slice(0, 300));
  const summary = [
    `The reviewer could not read the model's response (reason: \`${outcome.reason}\`). The review did not pass - it errored.`,
    outcome.detail,
    "",
    "First 300 characters of the raw output:",
    "```",
    preview,
    "```",
  ].join("\n");

  return {
    verdict: "comment",
    summary,
    issues: [],
    shouldFail: true,
    errored: true,
  };
}

/*
 * The preview is raw model output - text the model formed after reading
 * attacker-controlled PR/diff/thread content - embedded inside a
 * triple-backtick fence in a posted GitHub comment. A run of three or more
 * backticks anywhere in the preview closes the fence early and lets the
 * rest of the comment render as live markdown. Break every such run by
 * inserting a zero-width space inside it, so no run of length >= 3 survives.
 */
export function neutralisePreviewFences(text: string): string {
  return text.replace(/`{3,}/g, (run) => run.split("").join("​"));
}

// ─── Severity gating ─────────────────────────────────────────────────────────

function finaliseResult(
  output: AgentOutput,
  config: ReviewRulesConfig,
  threadContext?: ThreadContextBundle,
  fileSelection?: ReviewFileSelection,
  effectiveFocusAreas: string[] = []
): ReviewResult {
  const suppression = suppressAcceptedThreadIssues(output.issues, threadContext);
  const issues: LineComment[] = suppression.issues;
  const { shouldFail, gateSummary } = computeShouldFail(issues, config);
  const verdict = normaliseVerdict(output.verdict, issues);

  return {
    verdict,
    summary: buildSummaryMarkdown(
      output,
      issues,
      fileSelection,
      gateSummary,
      suppression.suppressedAcceptedThreadCount,
      fileSelection?.files.length ?? 0,
      effectiveFocusAreas
    ),
    issues,
    shouldFail,
    threadContext,
    fileSelection,
    gateSummary,
    suppressedAcceptedThreadCount: suppression.suppressedAcceptedThreadCount,
  };
}

export function suppressAcceptedThreadIssues(
  issues: LineComment[],
  threadContext?: ThreadContextBundle
): { issues: LineComment[]; suppressedAcceptedThreadCount: number } {
  const acceptedThreads =
    threadContext?.threads.filter((t) => t.state === "accepted_with_reason") ??
    [];
  if (acceptedThreads.length === 0) {
    return { issues, suppressedAcceptedThreadCount: 0 };
  }

  const filtered: LineComment[] = [];
  let suppressedAcceptedThreadCount = 0;

  for (const issue of issues) {
    const repeatsAcceptedThread = acceptedThreads.some(
      (thread) =>
        thread.path === issue.path && Math.abs(thread.line - issue.line) <= 3
    );
    if (repeatsAcceptedThread) {
      suppressedAcceptedThreadCount += 1;
      continue;
    }
    filtered.push(issue);
  }

  return { issues: filtered, suppressedAcceptedThreadCount };
}

function normaliseVerdict(
  requestedVerdict: Verdict,
  issues: LineComment[]
): Verdict {
  if (issues.length === 0) return "approve";
  if (issues.some((issue) => SEVERITY_RANK[issue.severity] >= SEVERITY_RANK.medium)) {
    return "request_changes";
  }
  if (requestedVerdict === "approve") return "comment";
  return requestedVerdict;
}

export function buildSummaryMarkdown(
  output: AgentOutput,
  issues: LineComment[],
  fileSelection?: ReviewFileSelection,
  gateSummary?: { blockEligibleCount: number; advisoryCount: number },
  suppressedAcceptedThreadCount = 0,
  reviewedFileCount = 0,
  effectiveFocusAreas: string[] = []
): string {
  const counts: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  for (const i of issues) counts[i.severity] += 1;

  const lines: string[] = [];
  lines.push(output.summary.trim());
  lines.push("");

  lines.push("**What was checked**");
  lines.push("");
  if (output.checked.length > 0) {
    for (const entry of output.checked) lines.push(`- ${entry}`);
  } else {
    const fileWord = reviewedFileCount === 1 ? "file" : "files";
    const focusAreaText =
      effectiveFocusAreas.length > 0
        ? effectiveFocusAreas.join(", ")
        : "no configured focus areas";
    lines.push(
      `- Reviewed ${reviewedFileCount} ${fileWord} against focus areas: ${focusAreaText}.`
    );
  }
  lines.push("");

  if (suppressedAcceptedThreadCount > 0) {
    lines.push(
      `**Accepted-thread suppression:** suppressed ${suppressedAcceptedThreadCount} re-raised finding(s) that matched prior accepted review threads.`
    );
    lines.push("");
  }

  if (fileSelection && fileSelection.truncatedCount > 0) {
    const reviewed = fileSelection.files.length;
    const eligible = reviewed + fileSelection.truncatedCount;
    lines.push(
      `**Partial review:** reviewed **${reviewed}** of **${eligible}** eligible files (cap: ${fileSelection.maxFiles}).`
    );
    if (fileSelection.omittedFiles.length > 0) {
      lines.push("");
      lines.push("Omitted paths (sample):");
      for (const path of fileSelection.omittedFiles) {
        lines.push(`- \`${path}\``);
      }
      if (fileSelection.truncatedCount > fileSelection.omittedFiles.length) {
        lines.push(
          `- _…and ${
            fileSelection.truncatedCount - fileSelection.omittedFiles.length
          } more_`
        );
      }
    }
    lines.push("");
  }

  if (
    gateSummary &&
    (gateSummary.blockEligibleCount > 0 || gateSummary.advisoryCount > 0)
  ) {
    lines.push(
      `**Merge gate:** ${gateSummary.blockEligibleCount} block-eligible · ${gateSummary.advisoryCount} advisory-only (below failure threshold)`
    );
    lines.push("");
  }

  if (issues.length === 0) {
    lines.push("**No actionable issues found.**");
  } else {
    lines.push(`**Issues found:** ${issues.length} total`);
    if (counts.critical > 0) lines.push(`- 🔴 Critical: ${counts.critical}`);
    if (counts.high > 0) lines.push(`- 🟠 High: ${counts.high}`);
    if (counts.medium > 0) lines.push(`- 🟡 Medium: ${counts.medium}`);
    if (counts.low > 0) lines.push(`- 🔵 Low: ${counts.low}`);
    if (counts.info > 0) lines.push(`- ℹ️ Info: ${counts.info}`);
  }

  return lines.join("\n");
}
