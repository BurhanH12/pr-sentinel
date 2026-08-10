import { Agent, CursorAgentError } from "@cursor/sdk";
import { env } from "../env.js";
import { logger } from "../utils/logger.js";
import type { TokenUsage } from "../observability/cost.js";

export interface AgentPromptOptions {
  apiKey: string;
  model: { id: string; params: { id: string; value: string }[] };
  local: { cwd: string };
}

/**
 * Invoke Agent.prompt with retries only for retryable CursorAgentError
 * (run never started). Does not retry mid-run failures.
 */
export async function promptAgentWithRetry(
  prompt: string,
  options: AgentPromptOptions
): Promise<{
  status: string;
  result?: string;
  id: string;
  durationMs?: number;
  /**
   * Token usage for the run. The installed @cursor/sdk's `RunResult` type
   * does not declare this field even though the SDK reports it at runtime -
   * declared here directly per the field names in Cursor's docs rather than
   * cast through `any`.
   */
  usage?: TokenUsage;
}> {
  const maxAttempts = 1 + env.CURSOR_AGENT_MAX_RETRIES;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await Agent.prompt(prompt, options);
      return result;
    } catch (err) {
      lastError = err;
      if (!(err instanceof CursorAgentError) || !err.isRetryable) {
        throw err;
      }
      if (attempt >= maxAttempts) {
        throw err;
      }
      const backoffMs = env.CURSOR_AGENT_RETRY_BASE_MS * attempt;
      logger.warn(
        { attempt, code: err.code, backoffMs },
        "Retrying Cursor agent after retryable error"
      );
      await sleep(backoffMs);
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
