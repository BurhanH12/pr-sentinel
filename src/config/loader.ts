import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Octokit } from "@octokit/rest";
import { z } from "zod";
import type { PathRulePack, ReviewRulesConfig } from "../types.js";
import { matchesAnyPattern } from "../github/diff.js";
import { env } from "../env.js";
import { logger } from "../utils/logger.js";

const severitySchema = z.enum(["critical", "high", "medium", "low", "info"]);

const reviewSkillRefSchema = z.enum([
  "code-review-and-quality",
  "nestjs-best-practices",
  "security-best-practices",
  "vercel-react-best-practices",
]);

/*
 * Mapped-type shapes below force every key of PathRulePack / ReviewRulesConfig
 * to have a matching schema property. `-?` makes each mapped key required on
 * the shape object itself, so if src/types.ts gains a field and this file
 * isn't updated, the shape object literal fails to satisfy its annotated
 * type ("Property 'x' is missing") and `pnpm typecheck` fails - the field
 * can no longer be silently dropped at the schema boundary.
 */
type PathRulePackShape = {
  [K in keyof PathRulePack]-?: z.ZodType<PathRulePack[K] | undefined>;
};

const pathRulePackShape: PathRulePackShape = {
  patterns: z.array(z.string()),
  rules: z.string().optional(),
  focusAreas: z.array(z.string()).optional(),
  skillRefs: z.array(reviewSkillRefSchema).optional(),
  failureThreshold: severitySchema.optional(),
};

const pathRulePackSchema: z.ZodType<PathRulePack> = z.object(
  pathRulePackShape
) as z.ZodType<PathRulePack>;

/*
 * Schema for a per-repo/central-config JSON override. Every field optional
 * (a layer only overrides what it sets); the shape is built from a mapped
 * type over keyof ReviewRulesConfig (see PathRulePackShape above for the
 * mechanism) so a field added to src/types.ts without a matching schema
 * entry here fails `pnpm typecheck` instead of being silently stripped by
 * zod at parse time.
 */
type ReviewRulesConfigShape = {
  [K in keyof ReviewRulesConfig]-?: z.ZodType<ReviewRulesConfig[K] | undefined>;
};

const reviewRulesConfigShape: ReviewRulesConfigShape = {
  rules: z.string().optional(),
  blockOnFailure: z.boolean().optional(),
  failureThreshold: severitySchema.optional(),
  excludePatterns: z.array(z.string()).optional(),
  maxFilesPerRun: z.number().int().positive().optional(),
  focusAreas: z.array(z.string()).optional(),
  pathRules: z.array(pathRulePackSchema).optional(),
};

export const reviewRulesConfigSchema: z.ZodType<Partial<ReviewRulesConfig>> =
  z.object(reviewRulesConfigShape) as z.ZodType<Partial<ReviewRulesConfig>>;

/*
 * Layered review-config resolution.
 *
 * Resolution order (later overrides earlier on a per-field basis):
 *   1. Hard-coded ORG_DEFAULTS (this file)
 *   2. Markdown rules in the orchestrator repo at cursor-config/review-rules.md
 *      — only rewrites the `rules` field.
 *   3. Central config repo (CONFIG_REPO_OWNER/NAME): repos/{owner}/{repo}.json
 *      — full Partial<ReviewRulesConfig>.
 *   4. Per-repo override committed in the target repo: .cursor/review-rules.json
 *      (full Partial) OR .cursor/review-rules.md (rules text only).
 *
 * Each layer is independent — a layer being missing is normal and never an error.
 */

const ORG_DEFAULTS: ReviewRulesConfig = {
  rules: "",
  blockOnFailure: false,
  failureThreshold: "high",
  excludePatterns: [
    "*.lock",
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "dist/**",
    "build/**",
    "*.generated.*",
    "*.min.js",
    "*.min.css",
    "coverage/**",
    ".next/**",
    "node_modules/**",
  ],
  maxFilesPerRun: 40,
  focusAreas: [
    "correctness",
    "security",
    "architecture",
    "performance",
    "consistency",
  ],
  pathRules: [
    {
      patterns: ["apps/api/**", "api/**", "server/**"],
      focusAreas: ["correctness", "security", "architecture", "performance"],
      skillRefs: ["nestjs-best-practices", "security-best-practices"],
      rules:
        "Backend/API changes must preserve module boundaries, validate external input, keep authorization explicit, and avoid new data-access shortcuts.",
    },
    {
      patterns: ["apps/web/**", "web/**", "app/**", "pages/**"],
      focusAreas: ["correctness", "performance", "consistency"],
      skillRefs: ["vercel-react-best-practices"],
      rules:
        "Frontend changes must respect Server/Client Component boundaries, avoid render waterfalls, and reuse established UI/data-fetching patterns.",
    },
  ],
};

export async function loadReviewConfig(
  octokit: Octokit,
  owner: string,
  repo: string
): Promise<ReviewRulesConfig> {
  let config: ReviewRulesConfig = { ...ORG_DEFAULTS };

  const builtinRules = await readBuiltinRulesMarkdown();
  if (builtinRules) {
    config = { ...config, rules: builtinRules };
  }

  if (env.CONFIG_REPO_OWNER && env.CONFIG_REPO_NAME) {
    const central = await fetchJsonFromRepo(
      octokit,
      env.CONFIG_REPO_OWNER,
      env.CONFIG_REPO_NAME,
      env.CONFIG_REPO_REF,
      `repos/${owner}/${repo}.json`
    );
    if (central) {
      config = mergeConfig(config, central);
      logger.debug({ owner, repo }, "Applied central config repo override");
    }
  }

  const repoJson = await fetchJsonFromRepo(
    octokit,
    owner,
    repo,
    "HEAD",
    ".cursor/review-rules.json"
  );
  if (repoJson) {
    config = mergeConfig(config, repoJson);
    logger.debug({ owner, repo }, "Applied per-repo JSON config");
    return config;
  }

  const repoMd = await fetchMarkdownFromRepo(
    octokit,
    owner,
    repo,
    "HEAD",
    ".cursor/review-rules.md"
  );
  if (repoMd) {
    config = mergeConfig(config, { rules: repoMd });
    logger.debug({ owner, repo }, "Applied per-repo Markdown rules");
  }

  return config;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/*
 * Look for cursor-config/review-rules.md adjacent to the orchestrator process
 * working dir. Falls back silently if absent (the ORG_DEFAULTS.rules empty
 * string is intentional — we treat that as "no extra rules").
 */
async function readBuiltinRulesMarkdown(): Promise<string | null> {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), "cursor-config", "review-rules.md"),
    join(here, "..", "..", "cursor-config", "review-rules.md"),
  ];

  for (const path of candidates) {
    try {
      const content = await readFile(path, "utf-8");
      if (content.trim().length > 0) return content;
    } catch {
      // try next candidate
    }
  }
  return null;
}

async function fetchJsonFromRepo(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  path: string
): Promise<Partial<ReviewRulesConfig> | null> {
  const raw = await fetchFileContent(octokit, owner, repo, ref, path);
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn(
      { err, owner, repo, path },
      "Failed to parse config JSON; ignoring"
    );
    return null;
  }

  const result = reviewRulesConfigSchema.safeParse(parsed);
  if (!result.success) {
    logger.warn(
      { owner, repo, path, issues: result.error.issues },
      "Config JSON failed schema validation; ignoring"
    );
    return null;
  }
  return result.data;
}

async function fetchMarkdownFromRepo(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  path: string
): Promise<string | null> {
  return fetchFileContent(octokit, owner, repo, ref, path);
}

async function fetchFileContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  path: string
): Promise<string | null> {
  try {
    const response = await octokit.repos.getContent({ owner, repo, path, ref });
    const data = response.data;
    if (Array.isArray(data) || data.type !== "file") return null;
    return Buffer.from(data.content, "base64").toString("utf-8");
  } catch {
    // 404 is the expected "no override here" path; swallow.
    return null;
  }
}

/*
 * Assigns a single field, generic over the field's key so the value type on
 * each side stays in lockstep without an `any` cast.
 */
function assignDefinedField<K extends keyof ReviewRulesConfig>(
  target: ReviewRulesConfig,
  override: Partial<ReviewRulesConfig>,
  key: K
): void {
  const value = override[key];
  if (value !== undefined) {
    target[key] = value;
  }
}

/*
 * Overwrites every field the override explicitly defines, leaving the rest
 * of `base` untouched. Driven by `Object.keys(override)` so a new
 * ReviewRulesConfig field is picked up automatically instead of needing a
 * matching line added here.
 */
export function mergeConfig(
  base: ReviewRulesConfig,
  override: Partial<ReviewRulesConfig>
): ReviewRulesConfig {
  const merged: ReviewRulesConfig = { ...base };
  for (const key of Object.keys(override) as Array<keyof ReviewRulesConfig>) {
    assignDefinedField(merged, override, key);
  }
  return merged;
}

/**
 * Path rule packs whose patterns match at least one changed file path.
 */
export function resolveMatchingPathRules(
  config: ReviewRulesConfig,
  changedPaths: string[]
): ReviewRulesConfig["pathRules"] {
  return config.pathRules.filter((pack) =>
    changedPaths.some((path) => matchesAnyPattern(path, pack.patterns))
  );
}
