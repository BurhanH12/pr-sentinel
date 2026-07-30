import { Octokit } from "@octokit/rest";
import { env } from "../env.js";

/*
 * GitHub API client authenticated with a fine-grained PAT.
 *
 * A single PAT covers every repo it has access to, so we cache one Octokit
 * instance for the process lifetime instead of minting per-installation
 * tokens. See .env.example for the required permission matrix.
 */
let octokitSingleton: Octokit | null = null;

export function getOctokit(): Octokit {
  if (octokitSingleton) return octokitSingleton;

  octokitSingleton = new Octokit({
    auth: env.GITHUB_PERSONAL_ACCESS_TOKEN,
    userAgent: "cursor-pr-agent/1.0",
  });

  return octokitSingleton;
}

/*
 * Build an https clone URL that embeds the PAT as the username.
 *   https://x-access-token:<PAT>@github.com/<owner>/<repo>.git
 *
 * GitHub accepts this for both classic and fine-grained tokens. The
 * resulting URL must be treated as a secret — never log it.
 */
export function buildAuthenticatedCloneUrl(
  owner: string,
  repo: string
): string {
  const token = encodeURIComponent(env.GITHUB_PERSONAL_ACCESS_TOKEN);
  return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
}
