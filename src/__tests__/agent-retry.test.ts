import { describe, it, expect, vi, beforeEach } from "vitest";
import { CursorAgentError } from "@cursor/sdk";

vi.mock("@cursor/sdk", async () => {
  const actual = await vi.importActual<typeof import("@cursor/sdk")>(
    "@cursor/sdk"
  );
  return {
    ...actual,
    Agent: {
      prompt: vi.fn(),
    },
  };
});

vi.mock("../env.js", () => ({
  env: {
    CURSOR_AGENT_MAX_RETRIES: 1,
    CURSOR_AGENT_RETRY_BASE_MS: 10,
    NODE_ENV: "test",
    LOG_LEVEL: "info",
  },
}));

vi.mock("../utils/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));

import { Agent } from "@cursor/sdk";
import { promptAgentWithRetry } from "../agent/cursor-invoke.js";

describe("promptAgentWithRetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retries once on retryable CursorAgentError", async () => {
    const retryable = Object.create(
      CursorAgentError.prototype
    ) as CursorAgentError;
    Object.assign(retryable, {
      message: "rate limit",
      code: "RateLimitError",
      isRetryable: true,
    });

    vi.mocked(Agent.prompt)
      .mockRejectedValueOnce(retryable)
      .mockResolvedValueOnce({
        status: "finished",
        id: "run-1",
        result: "{}",
      });

    const result = await promptAgentWithRetry("test", {
      apiKey: "key",
      model: { id: "m", params: [] },
      local: { cwd: "/tmp" },
    });

    expect(result.status).toBe("finished");
    expect(Agent.prompt).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-retryable errors", async () => {
    const fatal = Object.create(CursorAgentError.prototype) as CursorAgentError;
    Object.assign(fatal, {
      message: "auth",
      code: "AuthError",
      isRetryable: false,
    });

    vi.mocked(Agent.prompt).mockRejectedValueOnce(fatal);

    await expect(
      promptAgentWithRetry("test", {
        apiKey: "key",
        model: { id: "m", params: [] },
        local: { cwd: "/tmp" },
      })
    ).rejects.toBe(fatal);

    expect(Agent.prompt).toHaveBeenCalledTimes(1);
  });
});
