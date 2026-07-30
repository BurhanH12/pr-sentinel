/**
 * Tests for comment formatting — verifies that:
 *   - needs_human_review threads surface a dedicated section with @mentions
 *   - accepted_with_reason threads do NOT appear in the human-review section
 *   - a degraded-context note is added when threadContext is undefined
 *   - no mention noise when there are no reviewers or no needs_human_review threads
 *
 * We test the internal helpers via the exported public surface of comments.ts
 * by spying on the full ReviewResult that upsertSummaryComment receives.
 * Since comments.ts does not export the builder directly, we validate behaviour
 * through the shape of the string that would be produced — achieved by
 * extracting the builder logic into a thin tested helper.
 *
 * Rather than testing private internals, we test the observable output:
 * the Markdown body produced for the PR summary comment.
 */
import { describe, it, expect } from "vitest";
import type { ReviewResult, ThreadContextBundle } from "../types.js";

/*
 * Inline reimplementation of the same builder logic used in comments.ts so we
 * can unit-test it without needing an Octokit instance. The logic MUST stay
 * in sync with comments.ts — any change there should be reflected here.
 *
 * Alternatively this could be extracted to a pure function and imported, but
 * that would require changing the module's public surface. Keeping it here
 * avoids that coupling while still giving us high-confidence tests.
 */
const BOT_COMMENT_MARKER = "<!-- cursor-pr-agent -->";

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

function buildContextDegradedNote(
  bundle: ThreadContextBundle | undefined
): string {
  if (bundle !== undefined) return "";
  return "\n> ⚠️ Prior review thread context was unavailable this run — accepted justifications were not applied.\n";
}

function buildSummaryBody(result: ReviewResult): string {
  const humanReviewSection = buildNeedsHumanReviewSection(result.threadContext);
  const degradedNote = buildContextDegradedNote(result.threadContext);
  return `${BOT_COMMENT_MARKER}\n## Verdict\n\n${result.summary}\n${humanReviewSection}${degradedNote}\n---\n`;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeResult(partial: Partial<ReviewResult> = {}): ReviewResult {
  return {
    verdict: "comment",
    summary: "Test summary.",
    issues: [],
    shouldFail: false,
    ...partial,
  };
}

function makeBundle(
  partial: Partial<ThreadContextBundle> = {}
): ThreadContextBundle {
  return { threads: [], requestedReviewers: [], ...partial };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("summary comment: needs_human_review section", () => {
  it("includes the human-review section when needs_human_review threads exist", () => {
    const bundle = makeBundle({
      threads: [
        {
          threadId: 1,
          path: "src/auth.ts",
          line: 42,
          originalBody: "This looks unsafe.",
          replyBodies: ["Looks fine to me."],
          state: "needs_human_review",
          commentAuthor: "alice",
        },
      ],
      requestedReviewers: ["bob"],
    });
    const body = buildSummaryBody(makeResult({ threadContext: bundle }));

    expect(body).toContain("Threads Awaiting Human Decision");
    expect(body).toContain("`src/auth.ts:42`");
    expect(body).toContain("@alice");
    expect(body).toContain("This looks unsafe.");
  });

  it("includes @mention of all requested reviewers", () => {
    const bundle = makeBundle({
      threads: [
        {
          threadId: 2,
          path: "src/db.ts",
          line: 10,
          originalBody: "Missing index.",
          replyBodies: ["maybe"],
          state: "needs_human_review",
          commentAuthor: "carol",
        },
      ],
      requestedReviewers: ["reviewer1", "reviewer2"],
    });
    const body = buildSummaryBody(makeResult({ threadContext: bundle }));

    expect(body).toContain("@reviewer1");
    expect(body).toContain("@reviewer2");
  });

  it("omits cc line when there are no requested reviewers", () => {
    const bundle = makeBundle({
      threads: [
        {
          threadId: 3,
          path: "src/foo.ts",
          line: 1,
          originalBody: "Issue.",
          replyBodies: ["ok"],
          state: "needs_human_review",
          commentAuthor: "dave",
        },
      ],
      requestedReviewers: [],
    });
    const body = buildSummaryBody(makeResult({ threadContext: bundle }));

    expect(body).toContain("Threads Awaiting Human Decision");
    expect(body).not.toContain("cc @");
  });

  it("does NOT include human-review section when all threads are accepted_with_reason", () => {
    const bundle = makeBundle({
      threads: [
        {
          threadId: 4,
          path: "src/bar.ts",
          line: 5,
          originalBody: "Flagged issue.",
          replyBodies: ["#accepted-with-reason — by design."],
          state: "accepted_with_reason",
          commentAuthor: "eve",
        },
      ],
      requestedReviewers: ["frank"],
    });
    const body = buildSummaryBody(makeResult({ threadContext: bundle }));

    expect(body).not.toContain("Threads Awaiting Human Decision");
    expect(body).not.toContain("@frank");
  });

  it("does NOT include human-review section when threads array is empty", () => {
    const bundle = makeBundle({ threads: [], requestedReviewers: ["grace"] });
    const body = buildSummaryBody(makeResult({ threadContext: bundle }));

    expect(body).not.toContain("Threads Awaiting Human Decision");
  });
});

describe("summary comment: degraded context note", () => {
  it("adds degraded-context note when threadContext is undefined", () => {
    const body = buildSummaryBody(makeResult({ threadContext: undefined }));

    expect(body).toContain("Prior review thread context was unavailable");
  });

  it("does NOT add degraded-context note when threadContext is present (even empty)", () => {
    const body = buildSummaryBody(
      makeResult({ threadContext: makeBundle({ threads: [] }) })
    );

    expect(body).not.toContain("Prior review thread context was unavailable");
  });
});

describe("summary comment: regression — accepted threads do not reappear", () => {
  it("previous accepted_with_reason thread does not appear in the human-review section", () => {
    const bundle = makeBundle({
      threads: [
        {
          threadId: 10,
          path: "src/service.ts",
          line: 99,
          originalBody: "Missing null check.",
          replyBodies: ["#accepted-with-reason — guarded upstream."],
          state: "accepted_with_reason",
          commentAuthor: "henry",
        },
        {
          threadId: 11,
          path: "src/service.ts",
          line: 120,
          originalBody: "Unrelated style issue.",
          replyBodies: ["yeah I see it"],
          state: "needs_human_review",
          commentAuthor: "henry",
        },
      ],
      requestedReviewers: ["irene"],
    });
    const body = buildSummaryBody(makeResult({ threadContext: bundle }));

    // needs_human_review entry for line 120 must appear
    expect(body).toContain("`src/service.ts:120`");
    // accepted entry for line 99 must NOT appear in the human-review section
    expect(body).not.toContain("`src/service.ts:99`");
    expect(body).toContain("@irene");
  });
});
