# AGENTS.md — Cursor PR Review Agent

> **Source of truth** for any AI coding agent (Cursor, Codex, Copilot, Claude
> Code, Gemini CLI, etc.) working in this repository. Read this file in full
> before making changes.

---

## 1. What this project is

A self-hosted **PR review pipeline** built on top of [`@cursor/sdk`](https://cursor.com/docs/sdk/typescript).

The orchestrator is a long-running **Express HTTP server** that:

1. Receives GitHub `pull_request` webhooks (HMAC-verified via `@octokit/webhooks`).
2. For every PR opened / pushed-to / reopened / `ready_for_review` against a
   configured base branch (default `dev`), it spawns a **single Cursor
   agent** (local runtime) that reviews the PR against a layered set of
   rules and the actual current architecture of the base branch.
3. Publishes the agent's findings to GitHub as:
   - One **PR summary comment** (top-level, upserted on re-runs — never
     duplicated, identified by a hidden HTML marker).
   - **Inline line-level review comments** on the diff (posted as a single
     `event: "COMMENT"` review; falls back to per-comment posts if the bulk
     review is rejected).
   - One **GitHub check run** named `Cursor PR Review` that can optionally
     **block merge** when the configured severity threshold is hit.

The whole stack is meant to drop into any GitHub repo the orchestrator's PAT
has access to — no per-repo install step beyond pointing a webhook at this
server.

## 2. Where the requirements came from

The original requirement (`REQUIREMENT.md`) made these decisions explicit:

| Decision          | Choice                                                          |
| ----------------- | --------------------------------------------------------------- |
| Deployment        | Express HTTP server (direct GitHub webhooks)                    |
| Config location   | **Layered** — central defaults + per-repo overrides             |
| GitHub outputs    | PR summary + inline comments + check run (all three)            |
| Triggering branch | PRs targeting `dev` (configurable via `TARGET_BRANCHES`)        |
| Review baseline   | Against `dev` branch — agent must respect existing architecture |
| Reviewer engine   | `@cursor/sdk` (no third-party PR review tool)                   |

Decisions taken in the current setup pass (see chat history):

| Decision               | Choice                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| Cursor SDK runtime     | **`local`** — orchestrator clones PR head SHA itself, agent runs against that checkout        |
| Fan-out                | **Single combined agent** (one prompt, one check run, ~1/3 the cost vs. 3 parallel subagents) |
| GitHub auth            | **Single fine-grained PAT** (no GitHub App)                                                   |
| PAT identity           | Personal PAT (review comments author = PAT owner)                                             |
| Repo scope             | Any repo the PAT can see (no allowlist)                                                       |
| Webhook provisioning   | Manual (per-repo or org-level webhook configured in GitHub UI)                                |
| Node / package manager | Node ≥ 24, pnpm ≥ 9, enforced via `engines` + `engine-strict=true`                            |
| Env loading            | `dotenv/config` imported in `src/env.ts`                                                      |

## 3. Architecture diagram

```
┌──────────────────────────────┐
│  GitHub repo PR (any repo)   │
└───────────────┬──────────────┘
                │  pull_request webhook
                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ Express server (src/server.ts)                                           │
│  • HMAC-verifies request with GITHUB_WEBHOOK_SECRET                      │
│  • Filters: action ∈ {opened, synchronize, reopened, ready_for_review}   │
│             base branch ∈ TARGET_BRANCHES, draft === false               │
│  • Fork PR guard: skips fork PRs (Phase 2)                               │
│  • Calls enqueueReview() — responds 2xx immediately                      │
└───────────────────────────────┬──────────────────────────────────────────┘
                                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ Review queue (src/orchestration/queue.ts)                                │
│  • Posts "Queued for review" commit status immediately                   │
│  • Per-repo FIFO lanes + round-robin dispatch                            │
│  • Bounded: MAX_CONCURRENT_REVIEWS global, MAX_ACTIVE_PER_REPO per-repo  │
│  • Event-aware coalescing: dedupes same SHA, replaces stale SHA          │
│  • Overflow: posts "error" status, never silently drops                  │
└───────────────────────────────┬──────────────────────────────────────────┘
                                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ Orchestrator (src/orchestrator.ts)                                       │
│  1. Load layered config (config/loader.ts)                               │
│  2. Create pending GitHub status — "Review in progress" (checks.ts)      │
│  3. Fetch PR files + filter (github/diff.ts)                             │
│  4. Checkout head SHA via mirror cache → direct clone fallback           │
│     (github/clone.ts → github/repo-cache.ts)                            │
│  5. Run single Cursor agent against local clone (agent/runner.ts)        │
│  6. Upsert PR summary comment (github/comments.ts)                       │
│  7. Post inline review comments (github/comments.ts)                     │
│  8. Mark check completed: success | failure                              │
│  9. Always: cleanup the ephemeral checkout                               │
└──────────────────────────────────────────────────────────────────────────┘
```

## 4. File map

```
agent-orchestrator/
├── AGENTS.md                              ← this file
├── README.md                              ← human onboarding doc
├── REQUIREMENT.md                         ← original prompt
├── package.json                           ← Node ≥24, pnpm ≥9
├── pnpm-lock.yaml                         ← committed lockfile
├── tsconfig.json                          ← strict, ES2024, NodeNext, noUncheckedIndexedAccess
├── .env.example                           ← documents EVERY env var + PAT permission matrix
├── .gitignore
├── .nvmrc / .node-version                 ← pin Node 24
├── .npmrc                                 ← engine-strict=true, auto-install-peers
│
├── cursor-config/                         ← org-wide defaults shipped with the orchestrator
│   ├── review-rules.md                    ← NestJS+Next.js rules injected verbatim into the agent prompt
│   └── review-rules.example.json          ← schema template for per-repo overrides
│
├── skills/                                ← review skill files (copy from user-level ~/.agents/skills etc.)
│   ├── README.md                          ← explains the five skills and how to sync them
│   ├── code-review-and-quality/           ← five-axis review: correctness, readability, arch, security, perf
│   ├── nestjs-best-practices/             ← 40 NestJS rules (arch, DI, security, perf, DB, API, etc.)
│   ├── security-best-practices/           ← security review + vulnerability report skill
│   ├── next-best-practices/               ← Next.js 15+ (RSC, async params, file conventions, etc.)
│   └── vercel-react-best-practices/       ← 70 React/Next.js perf rules (waterfalls, bundle, re-renders)
│
└── src/
    ├── index.ts                           ← process entrypoint (signals + listen + mirror eviction)
    ├── server.ts                          ← Express app + webhook routing/filtering + fork guard
    ├── orchestrator.ts                    ← per-PR pipeline (steps 1-9 above)
    ├── env.ts                             ← zod-validated env, dotenv-loaded singleton
    ├── types.ts                           ← shared TS types (PR context, review result, queue job)
    │
    ├── agent/
    │   └── runner.ts                      ← @cursor/sdk Agent.prompt + zod-validated JSON
    │
    ├── config/
    │   └── loader.ts                      ← layered config: ORG_DEFAULTS → built-in MD → central repo → per-repo
    │
    ├── github/
    │   ├── auth.ts                        ← PAT-authed Octokit singleton + authenticated clone URL
    │   ├── clone.ts                       ← checkout via mirror cache with direct-clone fallback
    │   ├── repo-cache.ts                  ← bare git mirror cache + ephemeral checkout lifecycle
    │   ├── checks.ts                      ← queued / pending / update / fail / overflow commit status
    │   ├── comments.ts                    ← upsert summary comment + inline review (bulk → per-comment fallback)
    │   └── diff.ts                        ← paginated file fetch + exclude-glob filter + prompt formatter
    │
    ├── orchestration/
    │   └── queue.ts                       ← per-repo lane queues, round-robin dispatch, coalescing, enqueueReview()
    │
    └── utils/
        └── logger.ts                      ← pino logger (pino-pretty in dev)
```

## 5. Environment contract

All env vars are validated at process start by `src/env.ts` (zod). Boot
**fails fast** with a multi-line error listing every missing/invalid var if
anything is wrong. See `.env.example` for inline documentation on every var.

| Var                            | Required | Notes                                                                |
| ------------------------------ | -------- | -------------------------------------------------------------------- |
| `CURSOR_API_KEY`               | ✅       | From [cursor.com/dashboard](https://cursor.com/dashboard)            |
| `GITHUB_PERSONAL_ACCESS_TOKEN` | ✅       | Fine-grained PAT — see §6 for permission matrix                      |
| `GITHUB_WEBHOOK_SECRET`        | ✅       | Must match the secret set when creating the webhook in GitHub UI     |
| `PORT`                         |          | Defaults `3000`                                                      |
| `NODE_ENV`                     |          | `development` \| `production` \| `test`                              |
| `CLONE_BASE_DIR`               |          | Defaults `.tmp-clones`; ephemeral checkouts, cleaned up per-review   |
| `TARGET_BRANCHES`              |          | Comma-separated, lowercased. Default `dev`                           |
| `CONFIG_REPO_OWNER/NAME/REF`   |          | Optional central config repo (see §7)                                |
| `CURSOR_MODEL`                 |          | Default `composer-2.5`. Discover with `Cursor.models.list()`         |
| `CURSOR_THINKING`              |          | `low` \| `high`; only honored for composer-\* models                 |
| `LOG_LEVEL`                    |          | `info` by default                                                    |
| `MAX_CONCURRENT_REVIEWS`       |          | Default `2`. Total parallel agent runs across all repos              |
| `MAX_ACTIVE_PER_REPO`          |          | Default `1`. Prevents one busy repo monopolising all workers         |
| `MAX_QUEUED_REVIEWS`           |          | Default `200`. Hard cap on waiting jobs; overflow → error status     |
| `REPO_MIRROR_CACHE_DIR`        |          | Default `.repo-mirrors`. Bare git mirrors kept between reviews       |
| `REPO_MIRROR_TTL_MS`           |          | Default `86400000` (24 h). Mirrors idle longer than this are evicted |

## 6. GitHub PAT permission matrix

Create a **fine-grained PAT** at
https://github.com/settings/personal-access-tokens/new with these
repository permissions (granted to every repo whose PRs should be reviewed):

| Permission      | Access         | Why                                                     |
| --------------- | -------------- | ------------------------------------------------------- |
| Contents        | Read-only      | `git clone --depth=1` of the PR head SHA                |
| Metadata        | Read-only      | Mandatory baseline for any fine-grained PAT             |
| Pull requests   | Read and write | Create PR reviews + inline review comments              |
| Issues          | Read and write | PR top-level comments go through the issues API         |
| Commit statuses | Read and write | Posts the `Cursor PR Review` status in the PR merge bar |

> **Why not Checks?** The GitHub Checks API requires GitHub App authentication
> and returns 403 for every PAT regardless of scopes. We use commit statuses
> instead — identical merge-gate behaviour, works with a standard PAT.

The classic-PAT equivalent is the single `repo` scope (covers contents,
pull requests, issues, and commit statuses). Fine-grained is preferred —
narrower blast radius.

Webhook secret: **not** part of the PAT. Configure it directly on each
target repo's webhook UI (Settings → Webhooks → Add webhook), matching
`GITHUB_WEBHOOK_SECRET` exactly.

## 7. Layered config resolution

Resolved per PR by `src/config/loader.ts`. Later layers win, per-field:

1. **`ORG_DEFAULTS`** — hard-coded in `loader.ts` (`subagents → focusAreas`,
   `failureThreshold: "high"`, exclude globs for lockfiles / dist / etc.).
2. **`cursor-config/review-rules.md`** — bundled with the orchestrator; only
   overrides the `rules` field. Focused on NestJS and Next.js projects.
   Distilled from five review skills in `skills/` (code-review-and-quality,
   nestjs-best-practices, security-best-practices, next-best-practices,
   vercel-react-best-practices).
3. **Central config repo** (if `CONFIG_REPO_OWNER/NAME` env set) — fetches
   `repos/{owner}/{repo}.json` from that repo at `CONFIG_REPO_REF`.
   Full `Partial<ReviewRulesConfig>`.
4. **Per-repo override** — target repo's `.cursor/review-rules.json`
   (full `Partial<ReviewRulesConfig>`) OR `.cursor/review-rules.md`
   (rules text only). JSON wins if both exist.

`ReviewRulesConfig` shape (see `src/types.ts`):

```ts
interface ReviewRulesConfig {
  rules: string; // markdown injected into the prompt
  blockOnFailure: boolean; // true → check conclusion="failure" can block merge
  failureThreshold: Severity; // critical | high | medium | low | info
  excludePatterns: string[]; // glob patterns excluded from review
  maxFilesPerRun: number; // hard cap, default 40
  focusAreas: string[]; // prompt-only knob; default [security, performance, style]
}
```

## 8. Cursor SDK usage notes (important — easy to get wrong)

- We use **`Agent.prompt(message, options)`** (one-shot create + send + wait
  - dispose). Don't go back to `Agent.create + agent.send + run.stream(...)`
    unless you need streaming events for UI — the previous code in
    `runner.ts` had a broken stream parser (`event.type === "text"` is not a
    real event type; assistant text lives in `assistant.message.content[].text`).
- Runtime is **`local: { cwd }`** where `cwd` is the path returned by
  `github/clone.ts`. The agent gets full read access to the working tree at
  the PR head SHA. This is **cheaper and faster than `cloud:`** and does
  not require connecting GitHub at `cursor.com/dashboard`.
- Model `composer-2.5` with `params: [{ id: "thinking", value: "high" }]` is
  the default. To check available models at runtime, use `Cursor.models.list()`.
- Errors come in two flavors:
  - `CursorAgentError` thrown from `Agent.prompt` → the run **never
    started** (auth / config / network). Inspect `.code` and `.isRetryable`.
  - `RunResult.status === "error"` → the run started and failed
    mid-task. Treat as a non-retryable failure for now.
- **Structured outputs are not supported** by the SDK. We prompt the model
  to return JSON, then validate with the `agentOutputSchema` zod schema in
  `runner.ts`. Parse failures fall back to a "comment" verdict so we never
  surface a broken result.
- `Agent.prompt` disposes the agent for us. Do **not** add `await using`
  on top of it.

## 9. Conventions & coding standards

These are enforced by tooling (`tsconfig.json` strict mode) plus the user
rules attached to this repo:

- **TypeScript**: explicit types on every exported / public API. `any` is
  forbidden unless commented with a justification. Prefer interfaces / type
  aliases over inference for return types and DTOs.
- **DTOs**: anything entering the system from an external source (webhook
  payload → `PullRequestContext`, agent JSON → `agentOutputSchema`, env →
  `envSchema`) goes through an explicit type + zod validator.
- **Comments**: multi-line block comments above non-obvious logic explaining
  **why**, not what. Single-line redundant comments (`// Increment x`,
  `// Loop over files`) are removed. No "Updated X / Added Y" change-log
  comments.
- **Smallest possible change**: refactors not requested by the user are not
  done. Touched files should only change for the task at hand.
- **Octokit calls**: never `findAll`-style fetch huge payloads — paginate
  with `per_page: 100` and stop when results are short.
- **Exhaustive switch**: enum / union switches must have a `case` per
  member; no `default` that swallows new variants silently.
- **No inline imports**: all `import` statements at the top of the file. Do
  not use dynamic `import()` for anything other than truly conditional
  loads.

## 10. Commands

```bash
# pin Node (one-time, per shell)
nvm use

# install (will pick pnpm@9.15 via corepack thanks to "packageManager")
pnpm install

# dev mode — tsx watch, no build step
pnpm dev

# typecheck only (CI-friendly)
pnpm typecheck

# production
pnpm build && pnpm start
```

Smoke flow for local dev:

1. Run `pnpm dev`.
2. Forward webhooks via smee — **must include `--target` with the full path**:
   ```bash
   smee -u https://smee.io/<your-channel> --target http://localhost:3000/webhook
   ```
   Omitting `--target` (or pointing it at the root `/`) causes a 404 because
   the server only registers the `/webhook` route.
3. Point a test repo's webhook at the forwarded smee URL with the same
   `GITHUB_WEBHOOK_SECRET` as in `.env`.
4. Open a PR against `dev`. Watch the orchestrator logs.

## 11. Known gaps / future work (none required by current spec)

- No retry policy on transient `RateLimitError` from the Cursor SDK; one
  retry with backoff would be a low-risk addition.
- No persistent queue — the in-memory queue is lost on crash. A crash
  mid-review re-runs only when GitHub redelivers (manual retry from webhook
  UI, or push a new commit).
- No metrics export (Prometheus / OTel). Logs are structured JSON via Pino
  and can be scraped from stdout.
- No support for `/cursor review` slash command — only commit/PR events
  trigger reviews. Adding it would mean handling `issue_comment` events.
- **Fork PR support is deferred (Phase 2)**: PRs where the contributor's
  branch lives in a different repository (fork) are currently skipped with
  an info log. Full support requires splitting base/head repo identity in
  `PullRequestContext`, cloning the fork's head repo, and posting the commit
  status on the fork's SHA rather than the base repo.
- No adaptive rate-limit throttling: `RATE_LIMIT_THROTTLE_THRESHOLD` is
  planned but not yet implemented. If GitHub rate limits are hit, individual
  API calls will fail and the review will surface an error status.
- Mirror cache integrity is not verified on disk — a partially-written mirror
  (e.g. from a killed process) may cause `ensureMirror` to skip the clone
  and use a broken state. Mitigation: delete `.repo-mirrors` manually to
  force a fresh mirror on the next review.

## 12. Learned corrections & gotchas

- **smee `--target` must include the path**: Always run smee as
  `smee -u <url> --target http://localhost:3000/webhook`. Without `--target`
  smee forwards to the root (`/`), which returns 404 because only `/webhook`
  is registered.
- **`createNodeMiddleware` must be mounted at the app root**: Do not wrap it
  in `app.use("/webhook", createNodeMiddleware(...))` — Express strips the
  `/webhook` prefix before the middleware sees the request, causing a 404.
  Mount it at root and let the middleware own the full path internally.
- **`@octokit/webhooks` v13 rejects `log: false`**: The v13 API expects a
  Logger object, not a boolean. Omit the `log` option entirely if you don't
  need custom logging.
- **nvm doesn't persist across `bash -lc` calls**: Each `bash -lc '...'`
  spawns a fresh shell; `nvm use 24` in one call doesn't carry over.
  Prepend `export PATH="/home/cygnis/.nvm/versions/node/v24.13.0/bin:$PATH"`
  directly when you need Node 24 in dev/build commands.
- **`@cursor/sdk` local-runtime ripgrep warnings are non-fatal**: When the
  orchestrator runs outside the Cursor IDE, the SDK logs "Ripgrep path not
  configured. Call configureRipgrepPath() at startup." for `.gitignore` /
  `.cursorignore` file-indexing. The agent completes successfully regardless.
  `configureRipgrepPath` is **not** exported from the SDK's public API, so the
  orchestrator cannot silence these warnings; they can be safely ignored.

---

**When in doubt, read this file first, then `REQUIREMENT.md`, then the code.**
