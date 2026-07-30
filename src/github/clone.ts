import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import { env } from "../env.js";
import { logger } from "../utils/logger.js";
import { buildAuthenticatedCloneUrl } from "./auth.js";
import { createMirrorCheckout } from "./repo-cache.js";

export interface ClonedRepo {
  /** Absolute path to the local working copy. */
  cwd: string;
  /** Best-effort cleanup; safe to call multiple times. */
  cleanup: () => Promise<void>;
}

/*
 * Provide a working checkout of a repository at a specific commit SHA.
 *
 * Primary path: mirror-backed checkout (see repo-cache.ts).
 *   Mirror is fetched once per repo and reused across reviews, reducing
 *   GitHub clone time to the cost of fetching only new objects.
 *
 * Fallback path: direct shallow clone from GitHub.
 *   Used when the mirror cache fails (first run, network issues, etc.).
 *   A depth=1 fetch keeps clone time and disk bounded for large repos.
 */
export async function cloneRepoAtSha(
  owner: string,
  repo: string,
  headSha: string,
  prNumber: number
): Promise<ClonedRepo> {
  try {
    return await createMirrorCheckout(owner, repo, headSha, prNumber);
  } catch (err) {
    logger.warn(
      { owner, repo, prNumber, sha: headSha.slice(0, 7), err },
      "Mirror checkout failed — falling back to direct GitHub clone"
    );
    return await directClone(owner, repo, headSha, prNumber);
  }
}

/*
 * Direct shallow clone from GitHub.
 *
 * Kept as the fallback for the mirror path and as the baseline for repos
 * whose mirror has not yet been warmed. A depth=1 fetch means we only pull
 * the tree at headSha — no history, no other branches.
 */
async function directClone(
  owner: string,
  repo: string,
  headSha: string,
  prNumber: number
): Promise<ClonedRepo> {
  const base = resolve(process.cwd(), env.CLONE_BASE_DIR);
  await mkdir(base, { recursive: true });

  const target = join(
    base,
    `${owner}__${repo}__pr-${prNumber}__${headSha.slice(0, 12)}`
  );

  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });

  const log = logger.child({ owner, repo, prNumber, sha: headSha.slice(0, 7) });
  log.debug({ target }, "Direct-cloning PR head SHA from GitHub");

  const cloneUrl = buildAuthenticatedCloneUrl(owner, repo);

  const git: SimpleGit = simpleGit({ baseDir: target });
  await git.init();
  await git.addRemote("origin", cloneUrl);
  await git.fetch(["--depth=1", "origin", headSha]);
  await git.checkout(["FETCH_HEAD"]);

  log.info({ target }, "Direct clone complete");

  return {
    cwd: target,
    cleanup: async (): Promise<void> => {
      try {
        await rm(target, { recursive: true, force: true });
        log.debug({ target }, "Temp clone removed");
      } catch (err) {
        log.warn(
          { err, target },
          "Failed to remove temp clone (will be reaped on next boot)"
        );
      }
    },
  };
}
