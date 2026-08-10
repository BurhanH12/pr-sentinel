import { describe, it, expect } from "vitest";
import { suppressAcceptedThreadIssues } from "../agent/runner.js";
import type { LineComment, ThreadContextBundle } from "../types.js";

function issue(partial: Partial<LineComment> = {}): LineComment {
  return {
    path: "src/auth.ts",
    line: 40,
    side: "RIGHT",
    severity: "high",
    body: "Repeated finding.",
    ...partial,
  };
}

describe("suppressAcceptedThreadIssues", () => {
  it("drops issues that re-raise accepted findings on the same path near the same line", () => {
    const threadContext: ThreadContextBundle = {
      requestedReviewers: [],
      threads: [
        {
          threadId: 1,
          path: "src/auth.ts",
          line: 42,
          originalBody: "This was discussed already.",
          replyBodies: ["#accepted-with-reason guarded upstream"],
          state: "accepted_with_reason",
          commentAuthor: "reviewer",
        },
      ],
    };

    const result = suppressAcceptedThreadIssues(
      [
        issue({ line: 40 }),
        issue({ path: "src/payments.ts", line: 40, body: "New issue." }),
      ],
      threadContext
    );

    expect(result.issues).toEqual([
      issue({ path: "src/payments.ts", line: 40, body: "New issue." }),
    ]);
    expect(result.suppressedAcceptedThreadCount).toBe(1);
  });

  it("keeps issues outside the accepted-thread line window", () => {
    const threadContext: ThreadContextBundle = {
      requestedReviewers: [],
      threads: [
        {
          threadId: 1,
          path: "src/auth.ts",
          line: 42,
          originalBody: "This was discussed already.",
          replyBodies: ["#accepted-with-reason guarded upstream"],
          state: "accepted_with_reason",
          commentAuthor: "reviewer",
        },
      ],
    };

    const result = suppressAcceptedThreadIssues(
      [issue({ line: 50 })],
      threadContext
    );

    expect(result.issues).toHaveLength(1);
    expect(result.suppressedAcceptedThreadCount).toBe(0);
  });
});
