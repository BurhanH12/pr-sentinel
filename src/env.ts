import "dotenv/config";
import { z } from "zod";

/*
 * Environment schema for the PR review orchestrator.
 *
 * GitHub authentication is a single fine-grained Personal Access Token.
 * See .env.example for the exact permission matrix the PAT must carry.
 */
const envSchema = z.object({
  CURSOR_API_KEY: z.string().min(1, "CURSOR_API_KEY is required"),

  GITHUB_PERSONAL_ACCESS_TOKEN: z
    .string()
    .min(1, "GITHUB_PERSONAL_ACCESS_TOKEN is required")
    .refine(
      (token) => token.startsWith("ghp_") || token.startsWith("github_pat_"),
      "GITHUB_PERSONAL_ACCESS_TOKEN must be a GitHub PAT (ghp_* classic, or github_pat_* fine-grained)"
    ),

  GITHUB_WEBHOOK_SECRET: z.string().min(1, "GITHUB_WEBHOOK_SECRET is required"),

  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),

  CLONE_BASE_DIR: z.string().default(".tmp-clones"),

  /*
   * Comma-separated branch names. PRs whose base ref is NOT in this set are
   * silently ignored. Trimmed + lower-cased on read.
   */
  TARGET_BRANCHES: z
    .string()
    .default("dev")
    .transform((raw) =>
      raw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0)
    ),

  CONFIG_REPO_OWNER: z.string().optional(),
  CONFIG_REPO_NAME: z.string().optional(),
  CONFIG_REPO_REF: z.string().default("main"),

  CURSOR_MODEL: z.string().default("composer-2.5"),
  CURSOR_THINKING: z.enum(["low", "high"]).default("high"),

  /** Retries for retryable CursorAgentError (startup failures only). */
  CURSOR_AGENT_MAX_RETRIES: z.coerce.number().int().nonnegative().default(1),
  CURSOR_AGENT_RETRY_BASE_MS: z.coerce.number().int().positive().default(1000),

  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),

  /*
   * Review queue concurrency controls.
   *
   * MAX_CONCURRENT_REVIEWS — total parallel orchestratePRReview invocations.
   *   Conservative default of 2 to stay within Cursor API and GitHub rate limits.
   * MAX_ACTIVE_PER_REPO — prevents a single busy repo from monopolising all
   *   worker slots; round-robin fairness handles cross-repo burst.
   * MAX_QUEUED_REVIEWS — hard cap on jobs waiting in lanes; overflow jobs are
   *   rejected with an explicit GitHub commit status.
   */
  MAX_CONCURRENT_REVIEWS: z.coerce.number().int().positive().default(2),
  MAX_ACTIVE_PER_REPO: z.coerce.number().int().positive().default(1),
  MAX_QUEUED_REVIEWS: z.coerce.number().int().positive().default(200),

  /*
   * Repo mirror cache settings.
   *
   * REPO_MIRROR_CACHE_DIR — where bare git mirrors are kept between reviews.
   *   Mirrors reduce repeated clone time from GitHub to a local fetch.
   * REPO_MIRROR_TTL_MS — mirrors not used within this window are evicted.
   *   Default 24 hours. Set to 0 to disable eviction (not recommended for
   *   large installations with many repos).
   */
  REPO_MIRROR_CACHE_DIR: z.string().default(".repo-mirrors"),
  REPO_MIRROR_TTL_MS: z.coerce.number().int().nonnegative().default(86_400_000),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  • ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment variables:\n${issues}`);
  }

  return result.data;
}

export const env: Env = loadEnv();
