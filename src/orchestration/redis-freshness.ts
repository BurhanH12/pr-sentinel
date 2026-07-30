import { Redis } from "ioredis";
import { env } from "../env.js";
import type { RunFreshnessChecker } from "./stale-runs.js";

const SUPERSEDED_SET = "cursor-pr:superseded";

let redisClient: Redis | null = null;

function getRedis(): Redis | null {
  if (!env.REDIS_URL) return null;
  if (!redisClient) {
    redisClient = new Redis(env.REDIS_URL);
  }
  return redisClient;
}

export class RedisRunFreshnessChecker implements RunFreshnessChecker {
  async isCurrentRunAsync(runKey: string): Promise<boolean> {
    const redis = getRedis();
    if (!redis) return true;
    const member = await redis.sismember(SUPERSEDED_SET, runKey);
    return member === 0;
  }

  isCurrentRun(runKey: string): boolean {
    /*
     * Sync path used by orchestrator; Redis check is async. Worker mode should
     * pass a checker that was populated at job start. Fallback: assume current.
     */
    return true;
  }
}

export async function isRunSupersededInRedis(runKey: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  return (await redis.sismember(SUPERSEDED_SET, runKey)) === 1;
}
