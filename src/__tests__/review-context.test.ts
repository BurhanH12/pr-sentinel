import { describe, it, expect } from "vitest";
import { classifyThread, ACCEPTANCE_MARKER } from "../github/review-context.js";

describe("classifyThread", () => {
  describe("accepted_with_reason", () => {
    it("returns accepted_with_reason when the explicit marker is present", () => {
      expect(
        classifyThread([`${ACCEPTANCE_MARKER} we need this for legacy compat`])
      ).toBe("accepted_with_reason");
    });

    it("marker match is case-insensitive", () => {
      expect(classifyThread([ACCEPTANCE_MARKER.toUpperCase()])).toBe(
        "accepted_with_reason"
      );
    });

    it("marker embedded within a longer reply still matches", () => {
      expect(
        classifyThread([
          `Thanks for the review! ${ACCEPTANCE_MARKER} — see ADR-42.`,
        ])
      ).toBe("accepted_with_reason");
    });

    it("returns accepted_with_reason for 'by design' justification", () => {
      expect(
        classifyThread(["This is by design due to how the legacy API works."])
      ).toBe("accepted_with_reason");
    });

    it("returns accepted_with_reason for 'intentional' justification", () => {
      expect(
        classifyThread(["This pattern is intentional to avoid circular deps."])
      ).toBe("accepted_with_reason");
    });

    it("returns accepted_with_reason for 'won't fix' justification", () => {
      expect(
        classifyThread(["Won't fix — this is a known trade-off we accept."])
      ).toBe("accepted_with_reason");
    });

    it("returns accepted_with_reason for 'wontfix' justification", () => {
      expect(classifyThread(["wontfix — deferred to Q3 cleanup sprint."])).toBe(
        "accepted_with_reason"
      );
    });

    it("returns accepted_with_reason for 'known issue' justification", () => {
      expect(classifyThread(["known issue tracked in JIRA-1234."])).toBe(
        "accepted_with_reason"
      );
    });

    it("returns accepted_with_reason for 'deferred' justification", () => {
      expect(
        classifyThread([
          "Deferred to next sprint, creating a follow-up ticket.",
        ])
      ).toBe("accepted_with_reason");
    });

    it("returns accepted_with_reason for 'out of scope' justification", () => {
      expect(
        classifyThread(["out of scope for this PR, will address separately."])
      ).toBe("accepted_with_reason");
    });

    it("returns accepted_with_reason for 'tracked separately' justification", () => {
      expect(classifyThread(["tracked separately in issue #99."])).toBe(
        "accepted_with_reason"
      );
    });

    it("returns accepted_with_reason for 'because <substantial reason>' pattern", () => {
      expect(
        classifyThread([
          "We are keeping this because the upstream SDK requires it.",
        ])
      ).toBe("accepted_with_reason");
    });

    it("returns accepted_with_reason for 'due to <reason>' pattern", () => {
      expect(
        classifyThread(["Due to legacy constraints we cannot change this."])
      ).toBe("accepted_with_reason");
    });

    it("prefers marker match over all other signals", () => {
      expect(
        classifyThread([
          "Maybe we should fix this eventually",
          `${ACCEPTANCE_MARKER}`,
        ])
      ).toBe("accepted_with_reason");
    });
  });

  describe("needs_human_review", () => {
    it("returns needs_human_review when there are replies with no clear justification", () => {
      expect(classifyThread(["Looks fine to me."])).toBe("needs_human_review");
    });

    it("returns needs_human_review for an ambiguous short reply", () => {
      expect(classifyThread(["ok"])).toBe("needs_human_review");
    });

    it("returns needs_human_review for multiple non-justifying replies", () => {
      expect(classifyThread(["Checked it.", "Seems alright."])).toBe(
        "needs_human_review"
      );
    });
  });

  describe("needs_fix", () => {
    it("returns needs_fix when there are no replies", () => {
      expect(classifyThread([])).toBe("needs_fix");
    });
  });
});
