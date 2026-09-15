# PR-Sentinel: Audit, Decisions, and Improvement Plan

Date: 2026-07-31. Revised 2026-08-01 against `AI-CODE-REVIEW-MARKET-2026.md`.
Status: all design questions settled except the licence choice in §2.13, which carries a recommended default.

Verification: `pnpm typecheck` clean, `pnpm test` 46/46 passing.
The defects in §3.1 and §3.2 were confirmed by executing tests against the real functions, not by reading alone.

---

## 1. Thesis and positioning

**What this tool is:** a self-hosted, open-source PR reviewer that catches the bugs frontier models actually leave behind, at roughly a tenth the cost of the hosted alternatives.

**The wedge.** Most reviewers read the diff and ask "is this correct?".
Frontier models are extremely good at producing diffs that are locally correct.
What they get wrong is everything outside the diff: reimplementing a helper that already exists, introducing a second way to do something the codebase already had a convention for, quietly diverging from how every sibling module handles errors.

That means diff-only review is structurally incapable of catching frontier-model bugs, which is why every competitor plateaus in the same place.
CodeRabbit's CEO has said publicly that they catch technical issues but miss "architectural concerns, product logic errors, and team-specific context".
That is the gap.

**The review question is therefore not "is this diff correct?" but "does this change belong in this codebase?"**
That is a relational question, it requires navigating the repository rather than reading a patch, and it is the one thing no competitor ships well.

**The economic pitch.** Bugbot is roughly $1.00-1.50 per review. CodeRabbit is $24/developer/month, about $0.80 per PR at 30 PRs/developer/month.
Owning the infrastructure should cost under $0.10 per PR.
That is the headline claim, and §2 sets it as a hard, measured budget rather than an aspiration.
It is also not sufficient on its own, see §5.3.

**Two corrections to the positioning, from the August 2026 market survey.**

*Self-hosting is not the differentiator.*
Greptile ships a self-hosted Docker/Kubernetes deployment, Qodo's PR-Agent is Apache 2.0, and Kodus is AGPLv3 with a full Docker Compose stack.
"Open-source and self-hosted" is table stakes in this segment rather than a wedge.
What remains defensible is the combination in §1's thesis: consistency checks nobody ships well, plus measured and published signal quality that no vendor will disclose.

*Sell the control plane, not the speed.*
The market survey is unambiguous that 2024-2025 speed positioning ("review 10x faster, catch bugs instantly") is losing to governance positioning ("control layer between generation and merge, high signal, verifiable findings, policy-aware").
Adoption of AI review sits near 84% while trust in AI accuracy sits near 32.7%, and the buyer is spending against that gap rather than against review latency.
The plan's substance already matches the winning framing; the README and the landing copy should too.

---

## 2. Settled decisions

These were open questions. They are now answered, with reasoning. Nothing below is left to be decided later.

| # | Question | Decision |
|---|---|---|
| 1 | Block merges or advisory? | **Advisory by default.** Blocking is opt-in and only on consensus findings. |
| 2 | Who runs it? | **Strangers, on their own org repos.** Default-secure throughout. |
| 3 | TypeScript-only or general? | **TypeScript/JavaScript-first, stated loudly.** Pluggable analyzer interface, no other language shipped until contributed. |
| 4 | Eval data? | **Three tiers, two of which need no manual labelling.** Git-history mining and synthetic bug injection first. |
| 5 | Cost and latency budget? | **Under $0.10/PR median, hard abort at $0.50. p50 under 2 min, p95 under 5 min.** |
| 6 | Shippable false-positive rate? | **Under 15% dismissed, over 50% of posted comments actioned. Max 10 comments per PR.** |
| 7 | Token usage available? | **Yes.** `result.usage` exposes input/output/cache tokens. |
| 8 | Turn/tool-call cap? | **Not exposed as an option.** Enforce a budget via `run.stream()` and abort. |
| 9 | Prompt caching? | **Confirmed live.** `cacheReadTokens`/`cacheWriteTokens` prove it works and make it measurable. |
| 10 | Monorepo handling? | **Group changed files by resolved stack, one scoped pass per group, run in parallel.** |
| 11 | Dismissal feedback? | **GitHub-native, no UI, no database.** Reactions and thread state, persisted to a file in the reviewed repo. |
| 12 | Large PRs? | **Refuse honestly above threshold.** Review the high-risk subset and label it clearly. |
| 13 | Licence? | **Apache 2.0, recommended default.** See §2.13; this is the one item still open to a different call. |
| 14 | Switching cost for adopters? | **Read the competitor's config, export our own.** `.coderabbit.yaml`, `greptile.json`, `CLAUDE.md` (§2.14). |

### 2.1 Advisory by default (Q1)

The current default is already `blockOnFailure: false`, which means the whole gating apparatus is presently decorative.
That default is correct and should stay, but it should be deliberate rather than accidental.

For a tool strangers install, one false positive that blocks a merge destroys trust permanently and gets it uninstalled that afternoon.
Advisory-first earns the right to block.
Blocking becomes opt-in, and when enabled it fires only on findings that survived the verification pass with agreement across models - never on a single-pass finding, and never on self-reported confidence (see §3.7).

### 2.2 Assume untrusted input (Q2)

Assume the operator is a stranger running this on their own org's repos, reviewing PRs mostly from their own team, with fork PRs as the genuinely untrusted case.

Consequences, all non-negotiable:

- Never execute repository code outside a sandbox (§5.1).
- Fork PRs stay disabled by default, and the opt-in requires the sandbox to be configured.
- Treat PR bodies and code comments as untrusted input to the model. A merge-gating tool is a prompt-injection target.
- Never put the PAT in the environment of any process that runs repository code.

### 2.3 TypeScript-first, and say so (Q3)

Deep on TypeScript is a defensible niche.
Shallow across twenty languages is where every competitor already sits, and it is where this tool would lose.

Ship TS/JS only. Put the deterministic analysis behind a single `Analyzer` interface so a Python or Go implementation can be contributed without touching the orchestrator, but **do not build that abstraction speculatively** - define the interface when the second analyzer actually arrives. Being the best TypeScript PR reviewer is a stronger position than being the twelfth general one.

### 2.4 Eval data without manual labelling (Q4)

The eval cannot depend on hand-labelled data that does not exist. Three tiers, in build order:

**Tier 1 - git-history mining (no labelling, available immediately).**
Mine the repo for PRs whose bugs were fixed shortly after merge: revert commits, hotfixes, and commits whose message references the earlier PR.
The introducing PR plus the fixing diff gives automatically-labelled ground truth - "a real bug was here, at these lines".
Every repo with history has this for free, and it is the highest-value dataset available.

**Tier 2 - synthetic bug injection (no labelling).**
Take known-good merged PRs and mutate them: invert a boundary condition, drop a null check, swap an argument order, remove an await.
Measure detection rate. Cheap, unlimited volume, and it directly measures recall.

**Tier 3 - human-labelled golden set.**
20-30 PRs curated over time. Highest quality, slowest to build. Accumulate it from real usage rather than up front.

For an open-source tool the eval doubles as the credibility asset. Publish the harness and the measured numbers, including the false-positive rate. No vendor will do that.

### 2.5 Cost and latency budgets (Q5)

**Cost: under $0.10 per PR median. Hard per-review cap of $0.50, configurable.**
On hitting the cap, abort, publish what was found, and label the review partial. Never fail silently and never run unbounded.

This is enforceable now that §2 Q7 is settled: `result.usage` gives real token counts, so cost goes in `/metrics` as a first-class histogram from day one.

**Latency: p50 under 2 minutes, p95 under 5 minutes.**
Bugbot advertises 90 seconds. Multi-pass will not beat that, but under 2 minutes lands the review before the author has moved on.
Beyond 5 minutes the tool is decorative - not wrong, just late, which is far harder to notice because the accuracy metrics still look fine.

Enforcement: run panel passes in parallel, never sequentially, and hard-timeout with partial results rather than nothing.

### 2.6 Quality bar (Q6)

Three numbers, tracked in the eval:

- **Under 15% of posted comments dismissed as wrong.** Research puts the abandonment threshold at 10-15%.
- **Over 50% of posted comments actioned by a human.** This is the better metric - it measures usefulness, not just correctness.
- **Maximum 10 comments per PR, hard.** The current schema allows 50. Twenty speculative findings surrounding one real one is a failure even when recall is perfect.

Optimise precision@10, not raw recall.

**The external anchors, added 2026-08-01.**
The arXiv field study of 31K+ CodeRabbit review pairs reports 36.4% of comments accepted outright and 56.3% rejected.
Greptile and Qodo both claim roughly 73.8% suggestion acceptance.
GitHub reports 71% actionable for Copilot code review, with 29% noise, and that is apparently good enough to reach one in five GitHub reviews.

So the field spans roughly 36% to 74% acceptance, and the volume leader sits at the bottom of it.
The ">50% actioned" bar above is therefore a floor rather than a target; ship against 50%, aim at 70%+, and publish the number either way.
Publishing it is the part no vendor does.

### 2.7 SDK capabilities, verified (Q7, Q8, Q9)

Confirmed against Cursor's TypeScript SDK documentation:

**Token usage is reported.** `result.usage` gives `totalTokens`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`.
Cost instrumentation is therefore trivial and there is no excuse for guessing.

**Prompt caching is live**, proven by the presence of cache token counters.
This validates the prompt reordering in §6 and, better, makes the saving *measurable* - cache hit rate becomes a metric, not a hope.

**No explicit turn or tool-call cap is exposed.**
Enforce the budget yourself: use `Agent.create` plus `run.stream()`, watch `event.type === "usage"` per turn, and abort when the run exceeds the cap.

Note the tension this creates. `AGENTS.md` §8 currently warns against `run.stream()` in favour of one-shot `Agent.prompt`, because an earlier implementation had a broken stream parser.
That guidance is now outdated: `Agent.prompt` gives no mid-run control and therefore no way to bound cost.
Streaming is required for the cost kill-switch. Update that section rather than working around it.

**Cross-model is a config change.** Cursor proxies frontier models through the same interface - their own docs iterate `["composer-2", "gpt-5.5", "claude-opus-4-8", "gemini-3.1-pro"]` through `Agent.prompt` with only `model.id` changing.
No second vendor, no second key, no breaking the SDK dependency.
Resolve models by capability at boot via `Cursor.models.list()` with an `{ id: "auto" }` fallback, per Cursor's own guidance. Do not hardcode IDs.

### 2.8 Monorepo handling (Q10)

Resolve the stack **per changed file**, group files by resolved stack, and run one scoped pass per group in parallel.
A PR touching three packages produces three focused reviews instead of one confused one.

Detect workspace boundaries from `pnpm-workspace.yaml`, `package.json` workspaces, `turbo.json`, or `nx.json`, and resolve each package's stack from its own `package.json` rather than the root.
Next/Nest organisations are overwhelmingly monorepos, so this has to work on day one, not later.

### 2.9 Feedback without a UI or a database (Q11)

Use GitHub's native affordances only:

- **A 👎 reaction on a bot comment means false positive.** Zero UI, one click, unambiguous.
- **Thread resolved with the code changed** means actioned. Resolved without a code change means rejected.
- **Reply containing `#accepted-with-reason`** is already implemented and stays.

Persist the resulting suppressions to **`.pr-sentinel/suppressions.json` committed in the reviewed repo**.

This is the right shape for a self-hosted open-source tool: no database to run, learning is version-controlled and reviewable in a PR, it survives redeploys, it is portable between orgs, and a team can audit or hand-edit what their bot has learned.
It also means the learning travels with the repo rather than living in your server's disk.

### 2.10 Large PRs (Q12)

Above 40 changed files or 1,500 changed lines, do not silently truncate as the current code does.

Post an explicit notice that the PR exceeds the reliable-review threshold, review the highest-risk subset using the existing prioritisation in `diff.ts`, and label the result partial and prominent.
Honesty about the limit builds more trust than a confident partial review - and CodeRabbit's degradation on large PRs is a known, publicly conceded weakness worth not repeating.

### 2.11 Reviews must converge (added from §4.6)

The single most-engaged complaint found on X is that review does not converge: run, fix, run again, find new things, repeat.
That means the same code yields different findings on repeat runs, which is a nondeterminism problem masquerading as a thoroughness problem.

**Requirement:** on a re-review where a file is unchanged, previously-reported findings for that file must be reproduced or explicitly retracted, never silently dropped and never replaced with a fresh set.

Two mechanisms already in the plan deliver most of this:

- Comment dedup (§6 Phase 1) stops re-posting.
- Consensus filtering (§6 Phase 3) removes the marginal findings that flip between runs, which are precisely the ones causing the churn.

Add to the eval: **run the same PR twice and measure finding overlap.** Below about 80% overlap the tool will produce this complaint, regardless of how good any single review is.

### 2.12 Never return a silent pass (added from §4.6)

The inverse failure: a reviewer that finds nothing is assumed broken. "i'm 99% sure agent review is placebo bc i've never had it raise an issue."

The current clean-PR output is `**No actionable issues found.**`, which is exactly the unfalsifiable message that earns that reaction.

**Requirement:** every review states what it checked, not just what it found.
A clean review should read as "traced 4 changed exports to 11 call sites, compared 3 new functions against existing utilities, checked 2 controllers against sibling conventions, typecheck clean - no issues found."

This costs nothing, it is a summary-rendering change, and it converts an untrustworthy silence into visible work.
It also pairs with §6 item 22, since the summary is the most-valued output.

### 2.13 Licence (Q13, added 2026-08-01)

The market survey calls out "no kill switch" as an adoption driver for security-conscious orgs, and names the licences the OSS competitors chose: Kodus AGPLv3, GHAGGA Apache 2.0, jbot-review-action MIT, Qodo PR-Agent Apache 2.0.

**Recommendation: Apache 2.0.**
It carries an explicit patent grant, which matters to exactly the regulated buyers who want a self-hosted reviewer, and it is the licence a security team is least likely to bounce at intake.
AGPLv3 is the alternative if the goal is to prevent a hosted competitor from reselling this, but AGPL is banned outright at many of the enterprises that are the natural audience, so it defends revenue that does not exist at the cost of the users who do.

This is the one decision in this document taken on a recommended default rather than settled by evidence.
Reverse it before the first public release if the intent is commercial defensibility rather than adoption.

### 2.14 Make switching in cheap and switching out possible (Q14, added 2026-08-01)

The survey's clearest distribution finding is that successful OSS review bots lower switching cost deliberately.
jbot-review-action reads `.coderabbit.yaml` and `greptile.json` directly, so a team already tuned on a paid tool keeps its tuning.

**Decision, in two halves.**

*Read the incumbent's config.*
On boot, if `.coderabbit.yaml` or `greptile.json` exists in the reviewed repo, map the path filters, ignore rules, and severity preferences onto `ReviewRulesConfig`.
Also read `CLAUDE.md` or `AGENTS.md` if present, since a repo that documents its conventions for coding agents has already written most of a review-rules file.
This is a config adapter, roughly a day, and it converts a "rewrite your rules to try this" pitch into "point it at your repo".

*Export our own.*
The suppressions and rules in `.pr-sentinel/` stay human-readable and documented, so a team that leaves does not lose its calibration.
Saying this in the README is a trust signal that costs nothing, and it is the honest counterpart to reading everyone else's config.

---

## 3. Defects found

### 3.1 A typo in a per-repo config silently disables the merge gate (confirmed)

`src/config/loader.ts:161` casts fetched JSON without validating:

```ts
return JSON.parse(raw) as Partial<ReviewRulesConfig>;
```

`mergeConfig` passes it through via `??`.
In `src/agent/gating.ts:28`, `SEVERITY_RANK[config.failureThreshold]` is `undefined` for any out-of-enum value, and every `>= undefined` is `false`.

Confirmed: with `failureThreshold: "High"` in a repo's `.cursor/review-rules.json`, a critical/critical/confidence-1.0 issue yields `shouldFail === false`. Gate off, nothing logged.

Fix: zod-parse both config layers, fall back to `ORG_DEFAULTS` with a warning.
Also replace the hand-written field-by-field `mergeConfig` - adding a field and forgetting to update it silently drops all overrides for that field.

### 3.2 Inline comments duplicate on every push (confirmed)

No dedup exists between runs.
`upsertSummaryComment` correctly upserts via `BOT_COMMENT_MARKER`; `postInlineComments` does not.
`review-context.ts:177` explicitly excludes threads with no human reply, so the agent is never told it already said this.

Three pushes means three copies of the same still-valid finding.
This is the single largest noise generator in the repo, and noise is what makes teams uninstall within days.

Fix: list existing bot review comments, drop new issues matching on `(path, line ± 3)`. Roughly 20 lines, reusing the pagination already in `fetchThreadContext`.

### 3.3 The eval harness does not evaluate the reviewer

`src/eval/run-eval.ts` loads one hardcoded `example.json`, feeds a pre-written agent output into `computeShouldFail`, and asserts on threshold arithmetic.
The model is never invoked. It is worse than nothing because it looks like an eval and manufactures false confidence.

### 3.4 `learning/` is a write-only file

`recordMergeEvent` appends merge events nothing reads, disabled by default.
It records *that* a PR merged, not which findings were right - the wrong signal entirely.
The right signal is already flowing through `review-context.ts` and being discarded after one run (§2.9).

### 3.5 The skills directory is 99% dead weight

161 files, 1.4MB. `runtime-knowledge.ts:172` reads only `{skill}/SKILL.md`, truncated to 3,000 characters.
156 of 161 files are never opened. `code-review-and-quality/SKILL.md` is 14,285 bytes, so 79% of even the loaded file is cut.

And `skills/README.md` states `cursor-config/review-rules.md` is "a curated distillation of the rules above" - while that distillation is injected into the same prompt.
The model receives a summary and a truncated copy of the summary's source.

Per §4.3 this is a review-quality problem, not just tidiness.

### 3.6 AGENTS.md is substantially stale

It is labelled source of truth and read by coding agents, so drift causes bad changes:

- §1 and §3 say "check run"; the code uses commit statuses, which §6 correctly explains. The document contradicts itself.
- §4's file map lists one file in `orchestration/` (there are 6) and omits `learning/`, `eval/`, `context/`, `observability/`, `__tests__/`.
- §7's `ReviewRulesConfig` omits `pathRules`, `minConfidenceToBlock`, `riskThreshold`, and lists a wrong `focusAreas` default.
- §11 claims no retry policy, no persistent queue, and no metrics export. All three exist.
- §8's guidance against `run.stream()` is now actively harmful (§2.7).

### 3.7 The merge gate rests on a number the model invented

`minConfidenceToBlock: 0.7` gates merges on `confidence`, self-reported by the model.
`formatInlineComment` prints it on every comment: `confidence 85% · risk medium`.

Self-reported LLM confidence is uncalibrated.
This sits at the centre of the Greptile abandonment stories - not that it was wrong, but that it was wrong while displaying 4/5 confidence, costing developers real investigation time.

- **Stop displaying it.** Remove `confidence` and `risk` from rendered comment bodies.
- **Stop gating on it** until confidence comes from something real. Agreement across independent passes is a calibrated signal; self-report is not.
- **Collapse `risk` into `severity`.** Two self-reported enums doing the same job.
- **Cap issues at 10**, down from 50 (§2.6).

### 3.8 Smaller items

- **`redis-queue.ts` is not multi-worker safe.** `lpop` then `set` is not atomic, `stats()` uses `redis.keys()` in the request path, `RUNNING_KEY` is written and never read, `enqueueReviewRedis` constructs a fresh queue per call so its freshness checker is discarded immediately, and `REVIEW_JOB_LEASE_MS` is defined but never used - a crashed worker's job is simply lost.
- **`RedisReviewQueue.enqueue()` throws** to satisfy a shared interface. The abstraction is wrong.
- **Dynamic imports** in `queue.ts:278` and `server.ts:179` violate the repo's own §9 convention.
- **`fetchRequirementContext` injects a nag** when no ticket is linked, manufacturing a comment on every PR that does not reference an issue.
- **`parseAgentOutput` degrades schema failure into `verdict: "comment", issues: []`** - a malformed response becomes a clean pass, indistinguishable from a good PR.

---

## 4. Research findings

Confidence varies sharply and is flagged. Much of the published "benchmark" content on this topic is SEO material with untraceable numbers.

### 4.1 Cross-model review is real, and it is the opening

Greptile published research that models are measurably worse at reviewing code they wrote - the bug classes a model introduces are the classes it misses.
Supporting academic work: TriAdReview (arXiv 2606.15074) reports +27.6% on security audit tasks; an OpenReview adversarial-review paper shows the highest pass rate against a six-agent baseline.
In one head-to-head, a single model caught 3/10 routine bugs while models debating reached 7/10.

Production claims (Bugbot 52% to 70% resolution on moving to multi-model) come from low-quality sources and are directionally interesting only.

**You do not need to detect which model wrote the code**, and you should not try - commit trailers get stripped, PR markers are voluntary, style heuristics are unreliable.
You know the org's authoring model because it is a config value, and a two-model panel guarantees coverage regardless of author while producing the calibrated confidence §3.7 needs.

**Correction, 2026-08-01.** An earlier draft of this section claimed no major paid tool had shipped multi-model review.
That is no longer true and should not be repeated in any public copy.
Qodo runs a multi-agent suite per concern domain, Greptile runs parallel agents for logic, security, performance and architecture, and Sentry Seer runs a draft-then-parallel-verify topology.
The survey's own framing is that multi-model is now a commodity that buyers rank *below* expectations.

What is still uncommon is the specific use of a second, differently-authored model as a *filter* on the first model's findings rather than as an additional source of findings.
That distinction is the whole value, and §5.8 explains why getting it backwards makes things worse.
Per §2.7 the mechanism remains a config change, which keeps it cheap to try.

### 4.2 Multi-pass aggregation is the biggest measured quality lever

SWR-Bench (FSE 2026, 1000 verified PRs) reports multi-review aggregation improving F1 by up to 43.67%, discarding findings that appear in only one pass.
QASecClaw reports 88.6% false-positive reduction from a second LLM judging each finding against source context, at 3.1% recall loss.

Both peer-reviewed, both pointing the same way: one pass produces noise, consensus produces signal.

### 4.3 More context makes detection worse

SWE-PRBench (March 2026) found frontier models detect only 15-31% of human-flagged issues from a diff, and that this **degrades further when more context is supplied**, through attention dilution.

So "give the model more context" is the wrong instruction.
Targeted retrieval the agent chooses (trace the callers of this changed symbol) is categorically different from bulk stuffing (paste the rules, the skills, the threads, the requirements, and the diff) - and this repo currently does the second.
That makes §3.5 a precision fix.

### 4.4 Verification before reporting is the frontier

Greptile's TREX spawns a sandboxed agent per candidate finding to prove it before reporting. Almost nobody else does this, and it is the most credible route to a low false-positive rate.
See §5.1 for why the naive version of this is dangerous.

### 4.5 What developers actually say

Abandonment is fast: "I've tried Greptile and it's pretty much pure noise. I ran it for 3 PRs and then stopped using it." Teams typically disable within about 30 days.

**Confident wrongness is the specific aggravator**, not wrongness. See §3.7.

**Prioritisation failure beats detection failure**: "AI does not catch what actually matters - 20 highly speculative reasons why the code is problematic along with the one critical error." Recall was fine. The finding was buried.

**Verbosity is suspected to be commercially motivated** - "paid by the token and so they say more stuff." A self-hosted tool has no such incentive and can credibly say so.

**Convention drift is real and documented**: in one benchmark a frontier model was marked down for naming a variable `_tokens` where the convention was `_current_tokens`. Logic sound, convention drifted. That is §1's thesis in miniature.

**What genuinely lands**: PR summaries and diagrams ("one of the most helpful things for our team"), one-click fixes, and the division of labour where the bot takes style and obvious security while humans keep business logic.

Greptile publicly documented their nitpick fix: embedding-based similarity clustering over downvoted comments, KNN-matched to filter future ones.

### 4.6 What developers say on X

Gathered directly from X with an authenticated session. These are primary sources, quoted verbatim.

**Review does not converge.** Aiden Bai (@aidenybai), 328K views, 638 likes, 158 replies:

> why does cursor's bugbot not find all issues on the first try? i keep having to bugbot run -> fix in cursor -> bugbot run -> fix in cursor -> bugbot run over and over again

This is a failure mode not captured anywhere else in this research.
The tool finds a subset each run, so the same code produces different findings on repeat passes.
See §2.11 - it makes run-to-run stability a design requirement, not a nicety.

**Finding nothing destroys trust as fast as finding too much.** Same author, on Cursor's agent review:

> i'm 99% sure agent review is placebo bc i've never had it raise an issue

This is the exact inverse of the noise problem and the plan did not account for it.
A silent reviewer is assumed broken. See §2.12.

**Practitioners already run cross-model review by hand.** serafim (@korablev):

> Just use /review at Claude Code and Codex (both in parallel). 10x better than any other options.

Independent validation of §4.1 from a user rather than a vendor.
It also means cross-model is not a moat - people are hand-rolling it. The moat is §1's consistency checks.

**Teams run several reviewers at once because each catches different things.** Ben Vinegar (@bentlegen):

> @sentry's is actually pretty good - it's fast and often finds critical bugs coderabbit doesn't (we use both)

Useful positioning: this tool does not have to replace CodeRabbit, it can complement it.

**Actions-based review is already beating paid tools for some.** @nexxeln: "ngl claude code review in workflows is the best". Supports the §5.7 distribution decision.

**The winning architecture is being described as commodity.** darren (@darrenjr) on Tembo: "its just claude code + opus 4.5 in a vm for every PR".
Confirms the model is not the differentiator.

**Flat rate is the stated preference.** Minh-Phuc Tran (@phuctm97): "Having unlimited PR reviews at a flat rate is such a good deal, especially when compared to Cursor Bugbot or Vercel Agent."

**The market is more crowded than the secondary research suggested.** Named in that one thread: Sentry's reviewer (David Cramer, Sentry founder, replying "lmk if anyone other than bugbot beats us"), Tembo, Cubic, Mesa, Vercel Agent, Graphite.
None of them appear in the vendor-comparison listicles.

### 4.7 Pricing is a durable opening

Greptile moved to $30/seat plus $1/review past 50/month in March 2026.
One developer's real numbers: 571 PRs in 30 days, a jump from $30 to $500+, with the included quota covering 8.8% of actual usage.
Their public complaint names the structural problem exactly - stacked, small PRs are *good practice* and per-review pricing punishes them.

Bugbot dropped flat $40 for usage billing. Copilot code review consumes both Actions minutes and AI credits.

As AI agents push volume to 30-40 PRs/developer/month, per-review billing is actively misaligned with modern workflow. Self-hosted sidesteps it permanently.

### 4.8 The real competitive set is the OSS and Actions tier, not CodeRabbit

Everything above compares this tool to the paid leaders.
That is the wrong comparison for adoption.
A developer choosing between CodeRabbit at $24/seat and a self-hosted OSS reviewer is not the common case; the common case is a developer choosing between two free things, where the competition is:

| Tool | Shape | Licence | Weakness to exploit |
|---|---|---|---|
| **Kodus** | Docker Compose stack, BYO LLM, no call-home | AGPLv3 | Operational burden; limited UI polish; AGPL blocks enterprise intake |
| **Viper** | GitHub Action, BYO LLM | OSS | Ephemeral, no persistent state, diff-only, no cross-file context |
| **jbot-review-action** | GitHub Action, drives Cursor/Codex/Cline CLI | MIT | Lightweight, no persistent context; already reads `.coderabbit.yaml` (see §2.14) |
| **GHAGGA** | 17 static tools plus agentic orchestration | Apache 2.0 | Primarily a static-analysis aggregator; complex setup |
| **Qodo PR-Agent** | OSS half of a commercial product | Apache 2.0 | Smaller community than the paid tier it feeds |
| **Moraine** | Convention drift, explicit "the routine 80%" framing | unknown, emerging | Early stage, unproven |
| **VibeDrift** | Drift CLI plus MCP, learns dominant patterns, near-duplicate "Code DNA" | unknown, emerging | CLI/MCP shaped, not a PR reviewer |

Two of these matter more than the paid leaders do.

**jbot-review-action is the closest structural analogue** and it already does the config-reuse trick in §2.14.
**Moraine and VibeDrift are competing for this plan's exact thesis**, convention drift and architectural consistency, which §5.2 previously treated as an unowned gap.
It is not unowned; it is early.
Neither has shipped measured precision numbers, which is the opening: §2.4's published eval is the differentiator against them specifically, not against CodeRabbit.

The survey also names Sentry Seer, Sourcery, Codacy and Amazon CodeGuru.
None of them threaten a TypeScript-first, self-hosted reviewer: Seer requires production Sentry data and is GitHub-only, Sourcery is Python-only, CodeGuru is Java and Python only, and Codacy is static analysis with an AI layer rather than an AI reviewer.

### 4.9 Why Actions win over servers, in the survey's words

§5.7 already decided to ship the Action as the primary surface.
The survey supports it with reasoning worth keeping, because it also names what is lost.

For the Action: zero infrastructure, no credential management (the repo's own `GITHUB_TOKEN`, ephemeral runner tokens), free scaling, an audit trail GitHub keeps for you, and a fail-safe failure mode where a broken action means the PR is simply not reviewed rather than reviews stopping silently.

Against it: persistent state is what enables learning from dismissals, cross-repo orchestration needs shared infrastructure, and CI-embedded latency is worse than a webhook and a warm queue.

§2.9's decision to persist suppressions to a file in the reviewed repo is what resolves this tension.
It is the one design choice that buys the Action's operational profile without giving up the feedback loop, and it should be treated as load-bearing rather than as a convenience.

---

## 5. Risks

These are the ways this plan fails. They are ranked by severity and each has a mitigation that is part of the plan, not an afterthought.

### 5.1 Running repository code is remote code execution

Verification-before-reporting requires executing the repo's typecheck and lint.
That means executing code from a pull request. `pnpm install` runs `postinstall` scripts; `vitest.config.ts` executes on load.
A malicious PR gets arbitrary code execution on an orchestrator holding a **PAT with write access to every repo it reviews**, plus a Cursor key, in `process.env`.

The current fork-PR skip accidentally mitigates this. Implementing fork support without a sandbox opens it.

**Mitigation, non-negotiable:** container with no network, no credentials in environment, CPU and wall-clock caps, disposable filesystem, and `--ignore-scripts` on install.
Budget days for this, not hours, and treat it as a security feature.

Separately: PR bodies and code comments are untrusted input reaching a model that posts to GitHub. Prompt injection against a merge-gating tool is a live threat.
Fence untrusted content explicitly in the prompt and never let PR-supplied text alter review rules.

### 5.2 Duplicate detection may not be precise enough to carry the thesis

The headline feature rests on a check whose precision is unestablished.

- Two functions named `formatDate` handling timezones differently are **not** duplicates. Flagging them is a false positive.
- `toDisplayDate` and `formatDate` may be true duplicates. Name matching misses it.
- Signature matching on `(d: Date) => string` hits hundreds of functions.

Structural matching yields both false positives and false negatives; semantic matching returns to LLM judgment and its hallucination surface.
And duplication is *sometimes correct* - deliberate decoupling across module boundaries is a design decision. A bot flagging every near-duplicate becomes the nitpicking bot this plan exists to avoid.

**Mitigation:** prototype duplicate detection alone against 20 merged PRs and hand-count precision **before** building anything on top of it.
Below roughly 70% precision, the thesis needs rethinking rather than more engineering. This gate is Phase 1 (§6).

**The harder objection, added 2026-08-01.** The market survey argues duplicate detection is oversold outright: that it captures under 5% of real problems, that no vendor markets it as a primary value proposition, that VibeDrift ships it as a "nice-to-have" rather than a core feature, and that field deployments consistently rank security and logic bugs above duplication.

Note that this attacks a different axis than §5.2 does.
§5.2 asks whether the check can be made precise; the survey asks whether anyone cares when it is.
The precision gate does not answer the second question, so add a second measurement to it: of the true duplicates found across those 20 PRs, count how many a reviewer would actually have asked to change.

**Consequence for the plan.** Within §1's "does this change belong here?" thesis, the ordering changes.
Convention and architecture drift becomes the primary claim, and duplicate-capability detection becomes one supporting check among several rather than the headline.
Concretely, §6 Phase 2 items 12 and 13, sibling exemplars and executable architecture rules, are now ordered ahead of duplicate detection, which becomes item 14.
They are also cheaper, more deterministic and far less likely to produce the nitpicking behaviour this plan exists to avoid.

### 5.3 The plan is multiplicative and could raise cost

Two-pass (×2), cross-model panel (×2-3), stack-scoped passes on a full-stack PR (×2), plus larger inputs from exemplars and caller traces.
Worst case is 8-12 invocations where there is one today.

Routing only recovers this **if cheap triage genuinely filters**. If most files still reach the expensive pass, cost multiplies rather than divides.

**Mitigation:** the §2.5 budget with a hard abort, cost in `/metrics` from day one (now trivially available per §2.7), and the §6 rule that no multiplier ships before the eval can price it.

**And the inverse risk: cheap is not a thesis.**
The survey's second contrarian take is aimed squarely at this plan's headline claim.
"$0/seat plus LLM cost" ignores CI minutes, maintenance, and above all the rework caused by false positives.
The METR result it cites is the sharp version: developers believed AI made them 20% faster while objective measurement found them 19% slower, and median time-in-review is up 441% across the industry despite review tooling proliferating.

A reviewer that costs $0.08 per PR and wastes twenty minutes of a developer's time per week is more expensive than CodeRabbit, and the $0.10 metric will not show it.
**So the published headline number is cost per *actioned* comment, not cost per review.**
That is computable from what §6 item 5 already instruments plus the §2.9 feedback signal, it is the metric the survey says buyers have moved to, and it is one that cannot be gamed by being cheap and useless.
Keep cost per review as a secondary line item.

### 5.4 Latency is the silent killer

Every item makes reviews slower. If a review lands in 8 minutes, developers merge before it arrives and the tool becomes decorative - not wrong, just late, which the accuracy metrics will not reveal.

**Mitigation:** the §2.5 budget, parallel panel passes, and hard timeout with partial publish.

### 5.5 Unbounded agent exploration

The `local` runtime agent chooses its own tool calls and nothing bounds how many files it reads.
"Trace the callers" invites more of this. This risk exists **today**, before any change.

**Mitigation:** §2.7's streaming cost cap.

### 5.6 The test suite does not cover what is about to change

46 tests cover gating arithmetic, glob matching, and thread classification.
Nothing tests prompt construction, the GitHub publish path, or any end-to-end flow.
The §3.2 duplication bug survived precisely because nothing tests across runs.

**Mitigation:** an integration test for the publish path is a prerequisite for Phase 2, not a follow-up.

### 5.7 Distribution may not match the architecture

A long-running Express server needing a public URL, a per-repo webhook, and a PAT is a steep adoption cliff for an open-source tool.
Most OSS PR tooling ships as a **GitHub Action** - no server, no public endpoint, the repo's own `GITHUB_TOKEN`, and a far smaller blast radius.
An Action would also solve §5.1 largely for free, since runners are already disposable and isolated.

**Decision:** ship the GitHub Action as the primary distribution surface, and keep the server as the advanced multi-repo option.
Extract the review pipeline so both surfaces call the same core.
This is cheap now and expensive after five subsystems assume the server.

**Install must be one file and one secret.**
The survey is specific that this is the dividing line: Viper, jbot-review-action and GHAGGA's Action mode all install as a single workflow YAML, while Kodus requires Docker Compose plus infrastructure and has the adoption to match.
Treat "copy this YAML, add one secret, done" as an acceptance criterion for the Action, not as documentation polish.
Bring-your-own-model is part of the same criterion, since it lets a team reuse an existing Cursor or Anthropic seat instead of provisioning a new vendor relationship.

### 5.8 Multi-model can multiply noise instead of filtering it

The single most dangerous finding in the market survey for this plan.
A dev.to study ran Copilot, CodeRabbit and Claude agents across 30 PRs and found only **22% agreement**: 149 unique findings, very little overlap.
Stacking three reviewers produced roughly 3x the false positives for 1.3x the true positives, and teams are pulling back from multi-tool stacking as a result.

This is a direct threat to §6 item 18, because the failure mode is silent.
A panel that **unions** its findings gets exactly this asymmetric loss, and every accuracy metric except precision will look like it improved.

**Mitigation, and it is a design constraint rather than a preference.**
The panel exists to *discard*, never to accumulate.
A finding reported by one pass and not corroborated by another is dropped, not posted with a lower confidence.
This is what §4.2's cited result actually measures, SWR-Bench improves F1 by discarding single-pass findings, and QASecClaw's 88.6% false-positive reduction comes from a second model judging the first's output rather than producing its own.

The eval must therefore report precision and recall separately for single-pass and panel modes.
If the panel raises recall while dropping precision, it has failed, and the fact that total findings went up is not evidence that it worked.

### 5.9 Copilot's distribution beats quality, and that is fine

The survey's fifth contrarian take: Copilot code review admits 29% noise and is nonetheless one in five reviews on GitHub, with 60M+ completed as of March 2026.
Bundling and zero setup beat quality for adoption, and no amount of signal quality closes a distribution gap that large.

This is not a mitigable risk, so do not plan against it.
The implication is about who this tool is for.
The addressable user is the one who has already tried a bundled reviewer, found it noisy, and gone looking, which is a smaller and much better-qualified population than "teams that want AI code review".
Documentation, positioning and the eval should all be written for someone doing a comparison, not for someone discovering the category.
Complementary positioning helps here too, per §4.6: running alongside an incumbent is a lower bar than replacing one.

---

## 6. The plan

### Phase 0 - strip and correct - COMPLETE (2026-08-01)

All deletion, no risk.
Shipped on branch `phase-0-strip-and-correct`.
Verification after the phase: `pnpm typecheck` clean, `pnpm test` 45/45, `pnpm build` clean.
The test count fell from 46 because `learning-events.test.ts` went with the subsystem it covered; no other test was removed.

| Remove | Why |
|---|---|
| `src/eval/` as written | Tests arithmetic, not review quality (§3.3). Rebuilt in Phase 1. |
| `src/learning/` + merge webhook + 2 env vars | Write-only, wrong signal (§3.4). Replaced by §2.9. |
| 156 non-`SKILL.md` files under `skills/` | Never read (§3.5). |
| The "no linked ticket" prompt nag | Manufactures a comment on every PR (§3.8). |
| `RedisReviewQueue.enqueue()` stub, `REVIEW_JOB_LEASE_MS` | Broken abstraction; unused env var. |

Delete the Redis backend entirely.
It is not multi-worker safe (§3.8), and per §5.7 the primary surface is now an Action.
The in-memory queue is genuinely well built and is the supported path.

Rewrite `AGENTS.md` §1/§3/§4/§7/§8/§11 against the actual code (§3.6).

**What actually shipped.**
Every row of the table above landed, plus three items the whole-branch review surfaced.
`src/orchestration/queue-types.ts` was deleted too - its `ReviewQueueBackend` interface was the broken abstraction §3.8 names, and it outlived the Redis backend that was its only reason to exist; `EnqueueOutcome` and `QueueStats` moved into `queue.ts`.
Both dynamic imports §3.8 complains about are gone, at the old `queue.ts:278` and `server.ts:179`.
`skills/security-best-practices/LICENSE.txt` was restored after the prune deleted it, since the skill it licenses is still redistributed.

**Two findings carried into Phase 1.**

*`skills/next-best-practices/SKILL.md` is now empty of content.*
It was a pure table of contents pointing at the 15 files the prune removed, so after trimming the dangling pointers nothing substantive remains.
It is still inlined into every review prompt by `runtime-knowledge.ts`, where it costs tokens for a directive with no rules behind it.
Decide in Phase 1 whether to restore real content, drop the skill from `ReviewSkillRef`, or fold its scope into another skill.
The other four skills retain their inline content.

*`vitest` picks up compiled tests from `dist/`.*
After `pnpm build`, `pnpm test` reports 90 tests instead of 45, because the compiled copies under `dist/` match the test glob.
This silently doubles every count and would mask a deleted test.
The fix is an exclude in the vitest config, and it belongs with Phase 1 item 7 since the eval work depends on trustworthy test counts.

### Phase 1 - trust, and the two gates - COMPLETE (2026-09-15)

Nothing further gets built until the eval exists and duplicate detection proves itself.

Shipped on branch `phase-1-trust-and-gates`.
Verification after the phase: `pnpm typecheck` clean, `pnpm test` 155/155, `pnpm build` clean.

Item 9, the duplicate-detection precision gate, is deferred to the start of Phase 2 rather than
pre-run here - it needs a duplicate-detection prototype (Phase 2 item 14) and a human hand-count
over 20 merged PRs, neither of which can happen before that prototype exists.
It stays a gate on Phase 2's start, not a completed Phase 1 item.

The carried Phase 0 finding on `skills/next-best-practices/SKILL.md` was resolved by deletion
rather than by rewriting it with real content: the file had no rules behind its directive after
the Phase 0 prune, and Next.js coverage already lives in `vercel-react-best-practices`.

1. **Dedup inline comments** against existing bot comments (§3.2). ~20 lines. Highest-value change in the document.
2. **Stop displaying self-reported confidence; cap issues at 10** (§3.7, §2.6). Cheapest change available, targets the top two abandonment causes.
3. **Zod-validate config layers** (§3.1).
4. **Fail closed on unparseable agent output** (§3.8).
5. **Cost and latency instrumentation** - tokens, cost, cache hit rate, duration into `/metrics` via `result.usage` (§2.7). Everything after this is measured.
6. **Always show what was checked**, including on clean reviews (§2.12). Summary-rendering only, costs nothing, removes the "placebo" reaction.
7. **Build the eval** - Tier 1 git-history mining plus Tier 2 synthetic injection (§2.4), plus the run-twice stability measure from §2.11. Establishes the baseline all later work is judged against.
8. **Per-review cost in the comment footer** (§5.3). One line: "this review used $0.07 of compute across 2 passes." The survey lists transparent cost as an unowned gap, it is free once item 5 lands, and it is the credible version of §4.5's "we are not paid by the token".
9. **GATE: prototype duplicate detection and hand-count precision** on 20 merged PRs (§5.2). Below ~70%, revisit the thesis before proceeding. Also count how many true duplicates a reviewer would have asked to change, per §5.2's second measurement.
10. **Integration test for the GitHub publish path** (§5.6).

### Phase 2 - the thesis

Only after Phase 1's gates pass. This is the product.

Note the reordering against the original draft: consistency and architecture now lead, duplicate detection follows them, per §5.2.

11. **TypeScript language service integration** via `ts-morph` - exact go-to-definition and find-all-references, indexing only what the diff touches. Replaces grep-and-hope.
12. **Sibling-exemplar consistency** - for a new `*.controller.ts`, pull 2-3 existing controllers as reference. Targeted retrieval, not bulk context (§4.3). Promoted: this is the primary thesis check.
13. **Architecture rules as executable checks** - `dependency-cruiser` turns "backend changes must preserve module boundaries" from prose-to-an-LLM into a check that passes or fails.
14. **Duplicate-capability detection** - `ast-grep` structural search for existing functions matching the shape of new ones. Demoted to a supporting check (§5.2).
15. **Stack-scoped rule routing and monorepo grouping** (§2.8). Splits `review-rules.md` per stack; a backend PR never sees React rules. Serves precision, cost, and §4.3 simultaneously.
16. **Prompt reordering for cache** - static prefix first (rules, skills, schema), volatile last (PR meta, diff). Caching is confirmed live and the hit rate is measurable (§2.7).
17. **Config adapter for `.coderabbit.yaml`, `greptile.json`, `CLAUDE.md`** (§2.14). Roughly a day, and it removes the largest objection a team already running an incumbent will raise.

### Phase 3 - precision multipliers

Each of these multiplies cost, so each ships only when the eval shows it earns its price (§5.3).

18. **Two-pass verification** with a second model judging each candidate against source (§4.2). Cross-model panel is the mechanism (§4.1), and cross-pass agreement becomes the calibrated confidence §3.7 requires before gating can return. **The panel discards, it never accumulates** (§5.8), and the eval must report single-pass and panel precision separately.
19. **Sandboxed toolchain execution** - typecheck and lint as ground truth, inside the container specified in §5.1. On the Action surface the runner is already the sandbox, which is most of §5.1 for free and the cheap answer to Greptile's TREX.
20. **Feedback loop** - reactions and thread state to `.pr-sentinel/suppressions.json` (§2.9). Start with a dismissed-twice rule; add embedding KNN (§4.5) only when the rule list becomes unwieldy.
21. **Promote repeated feedback into rules.** Qodo's Rules System is the one governance feature the survey credits as unowned elsewhere: recurring feedback becomes a versioned, enforceable rule with a tracked lifecycle. §2.9's suppressions file is the suppression half of this; the promotion half is a small extension of the same file and the natural end state of the feedback loop.
22. **Invest in the PR summary.** §4.5 is clear that summaries are the most-loved output while inline comments are the most-resented. Currently a counts table. Cheap, and it lands where users want value.

### Explicitly not doing

- **Full call-graph indexing of the whole repo.** Greptile's differentiator and the source of their ~11 false positives per run. Diff-scoped language-service queries get most of the benefit at a fraction of the cost and latency.
- **Fork PR support** until §5.1's sandbox ships. It is a security boundary, not a feature gap.
- **Agent frameworks, vector databases, MCP servers.** The orchestration is a queue and a few calls; AST beats embeddings for "who calls this" (§4.3); the pipeline is headless and controls its own calls. Prefer deterministic tools over more LLM calls - every check pushed to a compiler costs no tokens and cannot hallucinate.
- **Detecting which model wrote the code** (§4.1).
- **Additional languages** until contributed (§2.3).
- **Cross-repository breaking-change detection.** A genuine unowned gap in the survey (only Qodo Enterprise and a multi-repo Greptile config address it), and genuinely valuable for microservice orgs. It also needs a persistent cross-repo dependency graph, which contradicts the Action-first surface in §5.7 and the no-index decision above. Revisit only if the server surface finds real users.
- **Firecracker or microVM sandboxing.** Item 19 gets the same outcome from a runner that GitHub already isolates and pays for.
- **Recommending this tool alongside two other reviewers.** Per §5.8, stacking reviewers is what produces the 3x-false-positives result. Complementing one incumbent is the supported story; complementing two is not.

---

## 7. Keep unchanged

The best parts of the repo. A refactor should not eat them.

- The in-memory queue: per-repo FIFO lanes, round-robin fairness, event-aware coalescing, overflow to explicit status.
- Stale-run suppression at both pre-publish checkpoints.
- The mirror cache with git alternates and TTL eviction.
- Commit statuses over the Checks API, with the reasoning documented.
- Bulk review with per-comment fallback in `comments.ts`.
- Graceful degradation throughout - thread context, requirements, and clone all fall back rather than failing the review.
- Layered config as a concept. Only its validation is broken.

---

## 8. Confidence

**High** - everything in §3, from reading the code, with the two most serious items confirmed by executed tests.

**High** - §2.7 SDK capabilities, verified directly against Cursor's TypeScript SDK documentation.

**High** - cross-model blind spots (§4.1), multi-pass aggregation (§4.2), and the abandonment/noise dynamics in §4.5, each from multiple independent sources including peer-reviewed work.

**Medium** - competitor architecture details, largely from secondary reporting rather than vendor engineering blogs.

**Low, and load-bearing on nothing** - circulating comparative benchmark numbers ("82% catch rate", "36.19% F1", "1.7x defect rate", "52% to 70% resolution"). These come from SEO content, measure different things on different datasets, and are not comparable. They appear in §4 for market context only.

**Coverage gap** - X/Twitter. Two attempts returned mostly vendor marketing; the `agent-reach` backend lacks credentials. One genuine developer thread was recovered (§4.6). Authenticating that backend would be needed to cover the platform properly.

### 8.1 Confidence in the 2026-08-01 additions

Material added on 2026-08-01 comes from `AI-CODE-REVIEW-MARKET-2026.md`, which grades its own sources. Carried forward at that grading:

**High** - the arXiv CodeRabbit field study (31K+ review pairs, 56.3% rejected / 36.4% accepted) and GitHub's own March 2026 numbers (60M reviews, 71% actionable, 29% noise). Primary, large-n, and the ones §2.6's bar now anchors to.

**Medium** - the existence and shape of the OSS competitors in §4.8, and the distribution patterns in §5.7. Directionally reliable, but the survey did not verify star counts, activity, or whether Moraine and VibeDrift are live products.

**Low** - every acceptance-rate figure sourced from a vendor. Greptile's and Qodo's 73.8% are self-reported, identical to one decimal place, and should be read as marketing convergence rather than measurement. §2.6 uses them as a ceiling to aim at, not as a validated benchmark.

**Single-sourced and load-bearing** - the 22% cross-tool agreement study behind §5.8. One dev.to study, n=30 PRs, not peer-reviewed. It is the sole evidence for a constraint that shapes item 18, so it should be treated as a hypothesis the eval tests directly rather than as an established result. The cheap test already exists: run the panel in union mode and intersect mode over the Tier 1 eval set and compare precision.

**Cited but stale** - the METR 19%-slower result in §5.3 is from 2024 and no 2026 replication was found. It supports a framing decision (cost per actioned comment), not a number.
