# Progress log

## 2026-08-01 - Phase 0: strip and correct

Branch: `phase-0-strip-and-correct` (base `9a804e5`).
Executed with subagent-driven development, five tasks, three of them dispatched in parallel.

**Shipped**

| Task | Commit |
|---|---|
| Remove the placeholder eval harness (§3.3) | `176f9e2` |
| Prune unread files from `skills/` (§3.5) | `4b05e1f` |
| Stop injecting a no-linked-ticket nag (§3.8) | `59bb3b2` |
| Remove the write-only learning subsystem (§3.4) | `4aeb4ff` |
| Remove the Redis queue backend and worker (§3.8, §5.7) | `4a0c884` |
| Rewrite AGENTS.md and README against the code (§3.6) | `c1f4f2d`, `f708c6c` |
| Final-review fixes: licence, dead queue interface, dangling skill pointers, doc corrections | `ca48912`, `56b4571`, `1af255d`, `02f902c` |

**Numbers**

`skills/` went from 161 files / 1.5M to 6 files / 76K.
Tests went from 46 to 45; the only removed test file is `learning-events.test.ts`, which covered the deleted subsystem.
`pnpm typecheck` clean, `pnpm test` 45/45, `pnpm build` clean.

**Verification**

Every task got an independent reviewer that re-ran the checks itself rather than trusting the implementer's transcript.
The whole-branch review ran on the most capable model and traced webhook receipt through to publish, since §5.6 notes no test covers that path.
One fix wave, then one scoped re-review, both clean.

**Open questions for the next session**

`skills/next-best-practices/SKILL.md` has no substantive content left and is still inlined into every prompt.
`vitest` counts compiled tests under `dist/` after a build, reporting 90 instead of 45.
Both are written up at the end of §6 Phase 0 in IMPROVEMENT-PLAN.md.

**Next**

Phase 1 - trust, and the two gates. Starts with comment dedup (§3.2), the highest-value change in the plan.
Phase 1 needs a fresh session with clean context.
