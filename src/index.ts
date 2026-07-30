import { createServer } from "./server.js";
import { env } from "./env.js";
import { logger } from "./utils/logger.js";
import { evictExpiredMirrors } from "./github/repo-cache.js";

/*
 * Process entry point. Boots the Express server and wires basic lifecycle
 * signal handlers so SIGINT / SIGTERM result in a clean shutdown rather than
 * a connection drop (matters under load balancers / container orchestrators).
 */
function main(): void {
  const app = createServer();

  /*
   * Evict mirror entries that have outlived REPO_MIRROR_TTL_MS on startup.
   * Non-fatal: a failure just means old mirrors linger until the next boot.
   */
  evictExpiredMirrors().catch((err) => {
    logger.warn({ err }, "Mirror eviction on startup failed");
  });

  const server = app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, env: env.NODE_ENV },
      "Cursor PR review agent listening"
    );
  });

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, "Shutdown signal received; closing server");
    server.close((err) => {
      if (err) {
        logger.error({ err }, "Error during server.close");
        process.exit(1);
      }
      process.exit(0);
    });

    setTimeout(() => {
      logger.warn("Forced shutdown after 10s grace period");
      process.exit(1);
    }, 10_000).unref();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "Unhandled promise rejection");
  });
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "Uncaught exception — exiting");
    process.exit(1);
  });
}

main();
