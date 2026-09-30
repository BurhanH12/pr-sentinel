import type { ReviewStack } from "./runtime-knowledge.js";

const KNOWN_STACKS: readonly string[] = ["nestjs", "nextjs", "react"];
const OPEN_MARKER = /^<!--\s*stack:\s*([a-z]+(?:\s*,\s*[a-z]+)*)\s*-->$/;
const CLOSE_MARKER = /^<!--\s*\/stack\s*-->$/;

/*
 * Drops stack-tagged blocks whose stacks were not detected in the target
 * repo. Fails open (returns the input unchanged) on any malformed or
 * unbalanced marker, and when no stack was detected, because stripping rules
 * on a detection miss would silently weaken the review.
 */
export function filterRulesByStacks(
  rules: string,
  stacks: ReviewStack[]
): string {
  if (stacks.length === 0) return rules;

  const out: string[] = [];
  let skipping = false;
  let open = false;

  for (const line of rules.split("\n")) {
    const trimmed = line.trim();
    const isMarker = /^<!--\s*\/?stack\b/.test(trimmed);

    if (!isMarker) {
      if (!skipping) out.push(line);
      continue;
    }

    const opened = OPEN_MARKER.exec(trimmed);
    /*
     * Any stack-marker-looking line must match one of the two regexes;
     * a near-miss (typo, missing colon) fails open rather than leaking into
     * the prompt or hiding a block boundary. Unrelated comments that merely
     * contain the word "stack" pass through.
     */
    if (opened?.[1] !== undefined) {
      const tagged = opened[1].split(",").map((s) => s.trim());
      if (open || !tagged.every((s) => KNOWN_STACKS.includes(s))) return rules;
      open = true;
      skipping = !tagged.some((s) => stacks.includes(s as ReviewStack));
    } else if (CLOSE_MARKER.test(trimmed)) {
      if (!open) return rules;
      open = false;
      skipping = false;
    } else {
      return rules;
    }
  }

  if (open) return rules;
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}
