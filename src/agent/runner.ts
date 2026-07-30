import { CursorAgentError } from "@cursor/sdk";
import { z } from "zod";
import { computeShouldFail, SEVERITY_RANK } from "./gating.js";
import { promptAgentWithRetry } from "./cursor-invoke.js";
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
  confidence: z.number().min(0).max(1).default(0.8),
  risk: z.enum(["critical", "high", "medium", "low", "info"]).default("medium"),
  body: z.string().min(1),
});

const agentOutputSchema = z.object({
  verdict: z.enum(["approve", "request_changes", "comment"]),
  summary: z.string().min(1),
  issues: z.array(lineCommentSchema).max(50).default([]),
});

type AgentOutput = z.infer<typeof agentOutputSchema>;

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
  const diff = formatDiffForPrompt(fileSelection.files);
  const prompt = buildReviewPrompt(
    pr,
    diff,
    config,
    threadContext,
    matchingPathRules,
    requirementSection,
    runtimeKnowledgeSection
  );

  log.info({ files: fileSelection.files.length }, "Invoking Cursor agent");

  let raw: string;
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
    log.info(
      { runId: result.id, durationMs: result.durationMs, chars: raw.length },
      "Cursor agent finished"
    );
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

  const parsed = parseAgentOutput(raw);
  return finaliseResult(parsed, config, threadContext, fileSelection);
}

// ─── Prompt builder ──────────────────────────────────────────────────────────

function buildReviewPrompt(
  pr: PullRequestContext,
  diff: string,
  config: ReviewRulesConfig,
  threadContext?: ThreadContextBundle,
  matchingPathRules: ReviewRulesConfig["pathRules"] = [],
  requirementSection = "",
  runtimeKnowledgeSection = ""
): string {
  const focusAreas = resolveEffectiveFocusAreas(config, matchingPathRules);
  const focusList = focusAreas
    .map((f, idx) => `${idx + 1}. **${f}**`)
    .join("\n");

  const threadContextSection = buildThreadContextSection(threadContext);
  const pathRulesSection = buildPathRulesSection(matchingPathRules);

  return `You are a senior staff engineer doing a thorough pull request review.

You are reviewing PR #${pr.prNumber} in \`${
    pr.repoFullName
  }\` against base branch \`${pr.baseBranch}\`.
The base branch represents the current project architecture — your job is to make sure the PR is
consistent with it and follows the rules below.

**PR title:** ${pr.prTitle}
**Author:** ${pr.authorLogin}
${pr.prBody ? `**Description:**\n${pr.prBody}\n` : ""}
${requirementSection}
## Focus areas

Cover all of these in a single combined review:
${focusList}

## Project review rules

${config.rules}
${pathRulesSection}${runtimeKnowledgeSection}${threadContextSection}
## Changed files (unified diff)

${diff}

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
  "issues": [
    {
      "path": "<file path relative to repo root>",
      "line": <positive integer — line number in the NEW file (right side of diff)>,
      "side": "RIGHT" | "LEFT",
      "severity": "critical" | "high" | "medium" | "low" | "info",
      "confidence": <number 0.0-1.0 — how sure you are this is a real issue>,
      "risk": "critical" | "high" | "medium" | "low" | "info",
      "body": "<concise, actionable explanation of the issue and how to fix it>"
    }
  ]
}
\`\`\`

Output rules:
- "issues" MUST be an empty array \`[]\` if nothing was found — never omit it.
- "verdict" = "approve" when no issues, "comment" for low/info only, "request_changes" otherwise.
- Do NOT invent issues. Only flag what you can point at in the diff or files.
- Maximum 50 issues total. Prioritise critical/high.
- Keep "body" actionable — name the fix, don't just describe the smell.
`;
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

function parseAgentOutput(raw: string): AgentOutput {
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
      verdict: "comment",
      summary: raw.slice(0, 500) || "Agent returned no parseable output.",
      issues: [],
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
      verdict: "comment",
      summary: raw.slice(0, 500),
      issues: [],
    };
  }

  const parsed = agentOutputSchema.safeParse(json);
  if (!parsed.success) {
    logger.warn(
      { issues: parsed.error.issues, preview: candidate.slice(0, 200) },
      "Agent JSON failed schema validation; using degraded fallback"
    );
    const fallback = json as { summary?: unknown; verdict?: unknown };
    return {
      verdict:
        typeof fallback.verdict === "string"
          ? validateVerdict(fallback.verdict) ?? "comment"
          : "comment",
      summary:
        typeof fallback.summary === "string" && fallback.summary.length > 0
          ? fallback.summary
          : raw.slice(0, 500),
      issues: [],
    };
  }

  return parsed.data;
}

function validateVerdict(value: string): Verdict | null {
  switch (value) {
    case "approve":
    case "comment":
    case "request_changes":
      return value;
    default:
      return null;
  }
}

// ─── Severity gating ─────────────────────────────────────────────────────────

function finaliseResult(
  output: AgentOutput,
  config: ReviewRulesConfig,
  threadContext?: ThreadContextBundle,
  fileSelection?: ReviewFileSelection
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
      suppression.suppressedAcceptedThreadCount
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

function buildSummaryMarkdown(
  output: AgentOutput,
  issues: LineComment[],
  fileSelection?: ReviewFileSelection,
  gateSummary?: { blockEligibleCount: number; advisoryCount: number },
  suppressedAcceptedThreadCount = 0
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
      `**Merge gate:** ${gateSummary.blockEligibleCount} block-eligible · ${gateSummary.advisoryCount} advisory-only (low confidence/risk)`
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
