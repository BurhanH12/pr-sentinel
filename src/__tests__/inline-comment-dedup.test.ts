/**
 * Tests for dropDuplicateIssues - the pure matching rule that prevents
 * postInlineComments from re-posting the same finding on every push.
 */
import { describe, it, expect } from "vitest";
import { dropDuplicateIssues } from "../github/comments.js";
import type { LineComment } from "../types.js";

function makeIssue(path: string, line: number): LineComment {
  return {
    path,
    line,
    side: "RIGHT",
    body: "some finding",
    severity: "medium",
  };
}

describe("dropDuplicateIssues", () => {
  it("drops an issue with an exact path and line match", () => {
    const issues = [makeIssue("src/a.ts", 10)];
    const existing = [{ path: "src/a.ts", line: 10 }];

    const { kept, droppedDuplicates } = dropDuplicateIssues(issues, existing);

    expect(kept).toHaveLength(0);
    expect(droppedDuplicates).toBe(1);
  });

  it("drops an issue when the line is off by 3 but keeps it when off by 4", () => {
    const closeIssue = makeIssue("src/a.ts", 13);
    const farIssue = makeIssue("src/a.ts", 14);
    const existing = [{ path: "src/a.ts", line: 10 }];

    const close = dropDuplicateIssues([closeIssue], existing);
    expect(close.kept).toHaveLength(0);
    expect(close.droppedDuplicates).toBe(1);

    const far = dropDuplicateIssues([farIssue], existing);
    expect(far.kept).toEqual([farIssue]);
    expect(far.droppedDuplicates).toBe(0);
  });

  it("keeps an issue on the same line but a different path", () => {
    const issue = makeIssue("src/b.ts", 10);
    const existing = [{ path: "src/a.ts", line: 10 }];

    const { kept, droppedDuplicates } = dropDuplicateIssues(
      [issue],
      existing
    );

    expect(kept).toEqual([issue]);
    expect(droppedDuplicates).toBe(0);
  });

  it("keeps everything when existing is empty", () => {
    const issues = [makeIssue("src/a.ts", 10), makeIssue("src/b.ts", 20)];

    const { kept, droppedDuplicates } = dropDuplicateIssues(issues, []);

    expect(kept).toEqual(issues);
    expect(droppedDuplicates).toBe(0);
  });

  it("returns correct counts for a mix of duplicate and unique issues", () => {
    const dup = makeIssue("src/a.ts", 10);
    const unique = makeIssue("src/a.ts", 100);
    const existing = [{ path: "src/a.ts", line: 10 }];

    const { kept, droppedDuplicates } = dropDuplicateIssues(
      [dup, unique],
      existing
    );

    expect(kept).toEqual([unique]);
    expect(droppedDuplicates).toBe(1);
  });
});
