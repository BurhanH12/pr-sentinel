import { describe, it, expect } from "vitest";
import { buildReviewPrompt } from "../agent/runner.js";
import { ORG_DEFAULTS } from "../config/loader.js";
import type {
  PullRequestContext,
  ReviewRulesConfig,
  ThreadContextBundle,
} from "../types.js";

const config: ReviewRulesConfig = {
  ...ORG_DEFAULTS,
  rules: "RULES-MARKER: never log secrets.",
};

function pr(n: number, title: string, body: string, author: string): PullRequestContext {
  return {
    owner: "acme",
    repo: "app",
    repoFullName: "acme/app",
    prNumber: n,
    prTitle: title,
    prBody: body,
    baseBranch: "dev",
    headBranch: `feat-${n}`,
    headSha: "abc",
    authorLogin: author,
    cloneUrl: "https://example.invalid/x.git",
    requestedReviewers: [],
  };
}

function thread(text: string): ThreadContextBundle {
  return {
    requestedReviewers: [],
    threads: [
      {
        threadId: 1,
        path: "src/a.ts",
        line: 3,
        originalBody: text,
        replyBodies: ["intentional"],
        state: "accepted_with_reason",
        commentAuthor: "bot",
      },
    ],
  };
}

function commonPrefix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.slice(0, i);
}

describe("buildReviewPrompt ordering", () => {
  const a = buildReviewPrompt(
    pr(101, "Title-Alpha", "Body-Alpha", "alice"),
    "DIFF-ALPHA-CONTENT",
    config,
    thread("THREAD-ALPHA"),
    [],
    "## Linked requirements\nREQ-ALPHA\n"
  );
  const b = buildReviewPrompt(
    pr(202, "Title-Beta", "Body-Beta", "bob"),
    "DIFF-BETA-CONTENT",
    config,
    thread("THREAD-BETA"),
    [],
    "## Linked requirements\nREQ-BETA\n"
  );
  const prefix = commonPrefix(a, b);

  it("shares a prefix holding rules and output schema but no PR-specific text", () => {
    expect(prefix).toContain("RULES-MARKER");
    expect(prefix).toContain('"verdict": "approve"');
    expect(prefix).toContain("Output rules:");
    for (const s of ["101", "Title-Alpha", "Body-Alpha", "alice", "THREAD-", "REQ-", "DIFF-"]) {
      expect(prefix).not.toContain(s);
    }
  });

  it("puts the diff last, followed only by the JSON-only reminder", () => {
    const tail = a.slice(a.indexOf("DIFF-ALPHA-CONTENT"));
    expect(tail).toBe(
      "DIFF-ALPHA-CONTENT\nReminder: reply with ONLY the JSON object described above.\n"
    );
  });
});
