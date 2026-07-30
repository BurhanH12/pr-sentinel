import {
  mkdir,
  rm,
  access,
  readdir,
  writeFile,
  readFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { simpleGit } from "simple-git";
import { env } from "../env.js";
import { logger } from "../utils/logger.js";
import { buildAuthenticatedCloneUrl } from "./auth.js";
import type { ClonedRepo } from "./clone.js";

/*
 * Repo mirror cache.
 *
 * Maintains one bare git mirror per (owner, repo) pair under REPO_MIRROR_CACHE_DIR.
 * For each review, the cache:
 *   1. Initialises or updates the mirror via git fetch --all --prune.
 *   2. Creates an isolated ephemeral checkout from the mirror using --local
 *      (git object alternates, near-zero copy cost).
 *   3. Returns the checkout path for the agent.
 *   4. Cleans up only the ephemeral checkout on review completion — the
 *      mirror persists for future reviews until TTL expiry.
 *
 * This reduces repeated GitHub clone time from O(repo size) to O(new objects
 * since last fetch), typically a few seconds on active repos.
 */

function cacheDir(): string {
  return resolve(process.cwd(), env.REPO_MIRROR_CACHE_DIR);
}

function mirrorPath(owner: string, repo: string): string {
  return join(cacheDir(), `${owner}__${repo}`, "mirror.git");
}

function lastUsedPath(owner: string, repo: string): string {
  return join(cacheDir(), `${owner}__${repo}`, "last_used");
}

async function touchLastUsed(owner: string, repo: string): Promise<void> {
  await writeFile(lastUsedPath(owner, repo), String(Date.now()), "utf-8");
}

async function readLastUsedMs(
  owner: string,
  repo: string
): Promise<number | null> {
  try {
    const raw = await readFile(lastUsedPath(owner, repo), "utf-8");
    const ts = parseInt(raw.trim(), 10);
    return Number.isFinite(ts) ? ts : null;
  } catch {
    return null;
  }
}

async function mirrorExists(owner: string, repo: string): Promise<boolean> {
  try {
    // A valid bare git repo always has a HEAD file.
    await access(join(mirrorPath(owner, repo), "HEAD"));
    return true;
  } catch {
    return false;
  }
}

/*
 * Initialise the mirror on first use, or refresh it on subsequent calls.
 * Returns the absolute path to the mirror directory.
 *
 * Falls back transparently if the mirror cannot be created or updated —
 * the caller is responsible for falling back to a direct GitHub clone.
 */
async function ensureMirror(owner: string, repo: string): Promise<string> {
  const mp = mirrorPath(owner, repo);
  const entryDir = join(cacheDir(), `${owner}__${repo}`);
  await mkdir(entryDir, { recursive: true });

  const cloneUrl = buildAuthenticatedCloneUrl(owner, repo);
  const log = logger.child({ owner, repo });

  if (await mirrorExists(owner, repo)) {
    const t0 = Date.now();
    const git = simpleGit({ baseDir: mp });
    await git.raw(["fetch", "--all", "--prune"]);
    log.debug(
      { mirrorPath: mp, durationMs: Date.now() - t0 },
      "Mirror refreshed"
    );
  } else {
    const t0 = Date.now();
    await simpleGit().clone(cloneUrl, mp, ["--mirror"]);
    log.info({ mirrorPath: mp, durationMs: Date.now() - t0 }, "Mirror created");
  }

  await touchLastUsed(owner, repo);
  return mp;
}

/*
 * Create an ephemeral working checkout at headSha backed by the mirror.
 *
 * The checkout uses git's "alternates" mechanism (--local clone) so no
 * objects are copied — setup is sub-second on any repo size. The checkout
 * is fully self-contained for reads; the mirror's objects are reachable
 * via .git/objects/info/alternates.
 *
 * If headSha is not present in the mirror (edge case: force-push, stale
 * mirror), it is fetched directly from GitHub before checkout.
 *
 * Throws on unrecoverable failures — the caller should catch and fall back
 * to a direct full clone.
 */
export async function createMirrorCheckout(
  owner: string,
  repo: string,
  headSha: string,
  prNumber: number
): Promise<ClonedRepo> {
  const base = resolve(process.cwd(), env.CLONE_BASE_DIR);
  await mkdir(base, { recursive: true });
  const checkoutPath = join(
    base,
    `${owner}__${repo}__pr-${prNumber}__${headSha.slice(0, 12)}`
  );

  await rm(checkoutPath, { recursive: true, force: true });

  const log = logger.child({ owner, repo, prNumber, sha: headSha.slice(0, 7) });
  const mp = await ensureMirror(owner, repo);

  try {
    const t0 = Date.now();

    /*
     * --local tells git to use the object alternates mechanism instead of
     * copying objects — the resulting checkout is populated via a reference
     * to the mirror's object store.
     */
    await simpleGit().clone(mp, checkoutPath, ["--local"]);

    const git = simpleGit({ baseDir: checkoutPath });

    try {
      await git.checkout([headSha]);
    } catch {
      /*
       * The SHA may not be reachable from any fetched branch (e.g. after a
       * force-push). Fetch it directly from GitHub as a one-off fallback.
       */
      log.debug({ headSha }, "SHA not found in mirror — fetching from GitHub");
      const cloneUrl = buildAuthenticatedCloneUrl(owner, repo);
      await git.addRemote("upstream", cloneUrl);
      await git.raw(["fetch", "--depth=1", "upstream", headSha]);
      await git.checkout(["FETCH_HEAD"]);
    }

    log.info(
      { checkoutPath, durationMs: Date.now() - t0 },
      "Mirror-backed checkout ready"
    );

    return {
      cwd: checkoutPath,
      cleanup: async (): Promise<void> => {
        try {
          await rm(checkoutPath, { recursive: true, force: true });
          log.debug({ checkoutPath }, "Ephemeral checkout removed");
        } catch (err) {
          log.warn(
            { err, checkoutPath },
            "Failed to remove ephemeral checkout"
          );
        }
      },
    };
  } catch (err) {
    await rm(checkoutPath, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/*
 * Remove mirror entries whose last_used timestamp is older than
 * REPO_MIRROR_TTL_MS. Called once at process startup to reclaim disk.
 *
 * Safe to call concurrently with reviews — it only targets repos whose
 * TTL has expired, which by definition have no active reviews.
 */
export async function evictExpiredMirrors(): Promise<void> {
  if (env.REPO_MIRROR_TTL_MS === 0) return;

  let entries: string[];
  try {
    entries = await readdir(cacheDir());
  } catch {
    return; // cache dir does not exist yet — nothing to evict
  }

  for (const entry of entries) {
    const separatorIdx = entry.indexOf("__");
    if (separatorIdx < 0) continue;
    const owner = entry.slice(0, separatorIdx);
    const repo = entry.slice(separatorIdx + 2);
    if (!owner || !repo) continue;

    const lastUsed = await readLastUsedMs(owner, repo);
    if (lastUsed === null) continue;

    if (Date.now() - lastUsed > env.REPO_MIRROR_TTL_MS) {
      const entryDir = join(cacheDir(), entry);
      await rm(entryDir, { recursive: true, force: true }).catch(() => {});
      logger.info({ owner, repo }, "Evicted expired repo mirror");
    }
  }
}
