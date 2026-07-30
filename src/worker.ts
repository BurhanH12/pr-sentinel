import { env } from "./env.js";
import { logger } from "./utils/logger.js";
import { createRedisWorkerLoop } from "./orchestration/redis-queue.js";
import { evictExpiredMirrors } from "./github/repo-cache.js";

/**
 * Standalone worker process for QUEUE_BACKEND=redis.
 * Polls Redis for jobs and runs orchestratePRReview.
 */
function main(): void {
  if (env.QUEUE_BACKEND !== "redis") {
    logger.error("Worker requires QUEUE_BACKEND=redis");
    process.exit(1);
  }

  logger.info({ workerId: env.WORKER_ID }, "Review worker starting");

  evictExpiredMirrors().catch((err) => {
    logger.warn({ err }, "Mirror eviction on worker startup failed");
  });

  const loop = createRedisWorkerLoop();

  const shutdown = (): void => {
    logger.info("Worker shutdown");
    loop.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
