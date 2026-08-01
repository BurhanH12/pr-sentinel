# Cursor PR Review Orchestrator

Automated PR review pipeline powered by [`@cursor/sdk`](https://cursor.com/docs/sdk/typescript).

Triggers on every PR opened, pushed to, or reopened against a configured base
branch (default `dev`). Spawns a single Cursor agent in **local runtime**
against a shallow clone of the PR head SHA, posts a top-level summary
comment + inline line-level comments, and sets a GitHub commit status that can
optionally block merge.

> Looking for the deep architectural context (file map, conventions, SDK
> gotchas)? See [`AGENTS.md`](./AGENTS.md).

---

## Architecture (high-level)

```
GitHub PR event (any repo the PAT has access to)
    │
    ▼
Express webhook server  ◄── HMAC-verified with GITHUB_WEBHOOK_SECRET
    │
    ├── Fork PR? → skip with explicit commit status (Phase 2: full fork support)
    ├── Post "Queued for review" commit status immediately
    │
    ▼
Review queue — memory (default) or Redis (`QUEUE_BACKEND`)
    │
    ├── Per-repo FIFO lanes + round-robin dispatch
    ├── MAX_CONCURRENT_REVIEWS / MAX_ACTIVE_PER_REPO / MAX_QUEUED_REVIEWS
    └── Event-aware coalescing (dedupe / replace stale SHA)
    │
    ▼
Review worker: orchestratePRReview(pr)   [same process or pnpm start:worker]
    │
    ├── Load layered config (ORG_DEFAULTS → cursor-config/ → central repo → per-repo)
    ├── Optional requirements context (linked issues / project items)
    ├── Post "Review in progress" commit status
    ├── Fetch PR diff (filtered, truncated) + checkout head SHA (mirror → clone fallback)
    │
    ▼
@cursor/sdk Agent.prompt({ local: { cwd } })  + confidence/risk gating
    │
    ▼
GitHub
    ├── PR summary comment (upserted on re-runs)
    ├── Inline line-level review comments (bulk review → per-comment fallback)
    └── "Cursor PR Review" commit status (success | failure)
```

---

## Multi-repo support

One running instance reviews PRs across **any number of repositories**.
Point each repo's webhook at the same server URL and ensure the PAT has
[the required permissions](#github-pat-permissions) on every target repo.

### Fairness and throughput

The review queue uses **per-repo FIFO lanes** dispatched in **round-robin** order
across a bounded pool of global workers. A burst of PRs in one repo will not
block reviews in another.

| Env var                  | Default | Description                       |
| ------------------------ | ------- | --------------------------------- |
| `MAX_CONCURRENT_REVIEWS` | `2`     | Total parallel agent runs         |
| `MAX_ACTIVE_PER_REPO`    | `1`     | Max parallel runs per repo        |
| `MAX_QUEUED_REVIEWS`     | `200`   | Max jobs waiting across all lanes |

When the queue is full an `error` commit status is posted immediately so the
developer knows to investigate rather than waiting indefinitely.

### GitHub commit status lifecycle

| Stage                   | Status    | Description                          |
| ----------------------- | --------- | ------------------------------------ |
| Webhook received        | `pending` | "Queued for review"                  |
| Worker slot assigned    | `pending` | "PR review in progress…"             |
| Review complete (pass)  | `success` | Issue count + verdict                |
| Review complete (block) | `failure` | Issue count + verdict                |
| Queue overflow          | `error`   | "Review rejected: queue at capacity" |

### Event-aware coalescing

Multiple pushes to the same PR are collapsed so only the latest SHA is
reviewed:

- `opened` / `reopened` / `ready_for_review` — same SHA already queued/running is silently dropped; different SHA replaces the queued job.
- `synchronize` — always replaces any queued job for the same PR with the newest SHA; if a review is already running, it is marked superseded and a single follow-up for the new SHA is queued.

### Repo mirror cache

Each repo's git object database is kept as a bare mirror under
`REPO_MIRROR_CACHE_DIR` (default `.repo-mirrors`). Per-review checkouts are
created as local clones of the mirror (near-zero copy via git alternates),
reducing repeated clone time from GitHub to only new objects since the last
fetch. Mirrors are evicted after `REPO_MIRROR_TTL_MS` (default 24 hours) of
inactivity.

### Fork PRs

Fork PRs (where the contributor's branch is in a different repository from
the base) are **not yet reviewed** — they receive an explicit **commit status**
(`Review skipped: fork PRs unsupported`) instead of running the agent. Full fork
support is planned for Phase 2.

---

## Prerequisites

- Node.js ≥ 24 (the repo ships `.nvmrc` / `.node-version` — run `nvm use`)
- pnpm ≥ 9 (auto-activated via the `packageManager` field if you have
  corepack enabled: `corepack enable`)
- A [Cursor](https://cursor.com) account with API access
- A GitHub repo (or org) you have admin access to (for webhook setup)

---

## Setup

### 1. Install

```bash
nvm use            # picks Node 24 from .nvmrc
corepack enable    # one-time, makes pnpm@9.15 available
pnpm install
```

### 2. Create a fine-grained Personal Access Token

Visit https://github.com/settings/personal-access-tokens/new and grant **Repository
permissions** to every repo you want the agent to review:

## GitHub PAT permissions

| Permission      | Access         |
| --------------- | -------------- |
| Contents        | Read-only      |
| Metadata        | Read-only      |
| Pull requests   | Read and write |
| Issues          | Read and write |
| Commit statuses | Read and write |

**Why not Checks?** The GitHub Checks API (check runs) requires GitHub App
authentication and rejects PATs with 403. This orchestrator uses commit statuses
instead — they appear in the PR merge bar the same way and work with the
permissions above.

(Classic PAT equivalent: the single `repo` scope, which also covers contents,
pull requests, issues, and commit statuses. Fine-grained is preferred — narrower
blast radius. The classic `repo` scope includes Checks API access, but this app
does not use it.)

Comments and reviews posted by the agent will be authored by the GitHub
account that owns the PAT — create a dedicated bot account for team use.

### 3. Configure `.env`

```bash
cp .env.example .env
```

Required values:

- `CURSOR_API_KEY` — [cursor.com/dashboard](https://cursor.com/dashboard) → Settings → API
- `GITHUB_PERSONAL_ACCESS_TOKEN` — the PAT from step 2
- `GITHUB_WEBHOOK_SECRET` — any high-entropy string (you'll paste the same
  value into GitHub's webhook UI in step 5)

Optional overrides (see `.env.example` for the full list):
`TARGET_BRANCHES`, `CURSOR_MODEL`, `CURSOR_THINKING`, `CLONE_BASE_DIR`,
`CONFIG_REPO_OWNER/NAME/REF`, `LOG_LEVEL`, `QUEUE_BACKEND`, `REDIS_URL`.

### 4. Run the server

The orchestrator has two queue modes (set in `.env`):

| Mode                    | `QUEUE_BACKEND` | Processes                                          | Best for                     |
| ----------------------- | --------------- | -------------------------------------------------- | ---------------------------- |
| **In-memory** (default) | `memory`        | One — webhook + reviews in the same Node process   | Local dev, single instance   |
| **Redis**               | `redis`         | Two — HTTP ingress enqueues; worker(s) run reviews | Production, horizontal scale |

`PORT` defaults to `3000`. Health: `GET /health`. Metrics: `GET /metrics`.

#### Local dev — in-memory queue (simplest)

Use this unless you need a durable Redis queue. No worker process.

**Terminal 1 — orchestrator (hot reload):**

```bash
pnpm dev
```

**Terminal 2 — forward GitHub webhooks with [Smee](https://smee.io):**

1. Open https://smee.io/new and copy your channel URL (e.g. `https://smee.io/xxxxxxxx`).
2. Point the repo webhook **Payload URL** at that Smee URL (see step 5 below).
3. Run (replace the URL; **`--target` must include `/webhook`**):

```bash
npx smee-client -u https://smee.io/YOUR_CHANNEL_ID --target http://localhost:3000/webhook
```

If you installed the CLI globally as `smee`, the same flags apply:

```bash
smee -u https://smee.io/YOUR_CHANNEL_ID --target http://localhost:3000/webhook
```

Open a PR against a watched branch (default `dev`) and watch logs in terminal 1.

#### Local dev — Redis queue (webhook + worker)

Reviews run in a **separate worker process**. The webhook server only enqueues jobs.

1. Start Redis locally (example with Docker):

```bash
docker run --rm -p 6379:6379 redis:7-alpine
```

2. In `.env`:

```bash
QUEUE_BACKEND=redis
REDIS_URL=redis://localhost:6379
```

3. **Terminal 1 — webhook / HTTP server:**

```bash
pnpm dev
```

4. **Terminal 2 — review worker** (must use `QUEUE_BACKEND=redis`; reads the same `.env`):

```bash
pnpm build && pnpm start:worker
```

For worker development without a full build:

```bash
npx tsx src/worker.ts
```

5. **Terminal 3 — Smee** (same as in-memory mode):

```bash
smee -u https://smee.io/YOUR_CHANNEL_ID --target http://localhost:3000/webhook
```

If `pnpm start:worker` exits with `Worker requires QUEUE_BACKEND=redis`, your `.env` still has `QUEUE_BACKEND=memory` or the worker was started without loading `.env`.

#### Production

**In-memory (single process):**

```bash
pnpm build && pnpm start
```

**Redis (ingress + one or more workers):**

```bash
# .env: QUEUE_BACKEND=redis, REDIS_URL=redis://...
pnpm build
pnpm start          # webhook + enqueue only
pnpm start:worker   # run on same host or scale workers horizontally
```

### 5. Configure the GitHub webhook

For each target repo (or once at the org level), go to **Settings → Webhooks →
Add webhook**:

- **Payload URL:** `https://your-server.example.com/webhook`
- **Content type:** `application/json`
- **Secret:** the same value as `GITHUB_WEBHOOK_SECRET` in your `.env`
- **SSL verification:** Enable
- **Events:** "Let me select individual events" → check **Pull requests** only

For local development, forward webhooks via [smee.io](https://smee.io) (see
[§4 Run the server](#4-run-the-server)) or `ngrok http 3000` and use that
forwarded URL as the webhook payload URL. With ngrok, use
`https://<subdomain>.ngrok.io/webhook` — not the root URL.

---

## Per-repo configuration

Any reviewed repo can override defaults by committing **one** of:

- `.cursor/review-rules.json` — full `Partial<ReviewRulesConfig>` (preferred)
- `.cursor/review-rules.md` — replaces just the `rules` text

Example `.cursor/review-rules.json`:

```json
{
  "blockOnFailure": true,
  "failureThreshold": "high",
  "excludePatterns": ["dist/**", "*.generated.*"],
  "focusAreas": ["security", "performance", "style", "tests"],
  "rules": "Additional repo-specific rules in markdown..."
}
```

See `cursor-config/review-rules.example.json` for the full schema and
`cursor-config/review-rules.md` for the bundled org-wide defaults.

### Central config repo (optional)

If `CONFIG_REPO_OWNER` + `CONFIG_REPO_NAME` are set in `.env`, the
orchestrator additionally pulls per-target-repo overrides from:

```
{CONFIG_REPO_OWNER}/{CONFIG_REPO_NAME}/repos/{owner}/{repo}.json
```

at ref `CONFIG_REPO_REF` (default `main`). Useful for org admins who don't
want to touch every reviewed repo.

---

## Watched branches

Set via `TARGET_BRANCHES` in `.env` (comma-separated, case-insensitive):

```bash
TARGET_BRANCHES=dev,staging
```

Default is `dev`.

---

## Deployment

The server is a plain Node.js HTTP listener — deploy anywhere:

- **Railway / Render / Fly.io** — set env vars in the dashboard, deploy.
- **Docker** — `FROM node:24-alpine`, copy `dist/`, set env vars.
- **Bare VM** — `pnpm install && pnpm build && pnpm start` behind nginx /
  Caddy with TLS.

GitHub needs to reach `/webhook` publicly. See [§4 Run the server](#4-run-the-server)
for memory vs Redis process layout. `GET /metrics` exposes queue depth and
latency histograms as JSON.

---

## Project structure (short tour)

See [`AGENTS.md`](./AGENTS.md) for conventions and SDK notes. Layout:

```
agent-orchestrator/
├── src/
│   ├── index.ts              HTTP entry (signals, mirror eviction, listen)
│   ├── worker.ts             Redis queue consumer (`pnpm start:worker`)
│   ├── server.ts             Express + webhook routing + fork guard
│   ├── orchestrator.ts       per-PR pipeline
│   ├── env.ts / types.ts     zod env + shared types
│   ├── agent/                  Cursor SDK invoke, gating, JSON validation
│   ├── config/loader.ts      layered review rules
│   ├── context/                optional requirements / issue context
│   ├── github/                 PAT auth, clone, mirror cache, diff, comments, statuses
│   ├── orchestration/          memory + Redis queues, coalescing, stale-run guard
│   ├── observability/          `/metrics` JSON
│   └── __tests__/              vitest unit tests
├── cursor-config/            org-wide review rules + JSON schema example
├── skills/                   bundled review skills (see skills/README.md)
├── evals/golden-prs/         example golden fixtures for eval harness
├── AGENTS.md                 agent / contributor source of truth
└── .env.example              all env vars (never commit `.env`)
```

Runtime directories (gitignored): `.tmp-clones/` (ephemeral PR checkouts),
`.repo-mirrors/` (bare mirror cache; may embed PAT in git remote URLs).

---

## Troubleshooting

- **`Invalid environment variables`** on boot → fields named in the error
  message are missing/invalid in `.env`. Check `.env.example`.
- **Webhook 401 / signature mismatch** → `GITHUB_WEBHOOK_SECRET` in `.env`
  doesn't match what you set in the GitHub webhook UI.
- **Smee shows `POST …/webhook - 200` but nothing runs** → the server
  accepted the delivery; check orchestrator logs for `GitHub webhook received`.
  Common causes:
  - Webhook is not subscribed to **Pull requests** (only `ping` / `push` fire).
  - PR **base branch** is not in `TARGET_BRANCHES` (default `dev`).
  - PR is still a **draft** (convert to ready for review or push after marking ready).
  - **Fork PR** — cross-repo head branches are skipped until Phase 2 (log:
    `Skipping fork PR`).
  - Bad signature would be **400**, not 200 — if you see 200, the secret matches.
- **Octokit 404 fetching PR files** → PAT doesn't have access to that repo,
  or it's missing the `Contents: read` + `Pull requests: read` permissions.
- **`CursorAgentError: IntegrationNotConnected`** → would only happen on
  `cloud:` runtime; we use `local:` so this should never appear. If it
  does, recheck `src/agent/runner.ts`.
- **Inline comments silently dropped** → GitHub rejects bulk reviews if any
  single comment is outside the PR diff hunks. The orchestrator falls back
  to per-comment posting and drops the ones GitHub refuses; see logs at
  `level=info` with message `Per-comment fallback complete`.
- **`Worker requires QUEUE_BACKEND=redis`** → set `QUEUE_BACKEND=redis` and
  `REDIS_URL` in `.env`, ensure Redis is running, then start `pnpm start:worker`
  (after `pnpm build`) or `npx tsx src/worker.ts`.
- **Smee 404 on webhook** → `--target` must be `http://localhost:3000/webhook`,
  not `http://localhost:3000/`.
