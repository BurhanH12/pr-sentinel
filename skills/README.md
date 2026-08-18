# Review Skills

This directory holds the SKILL.md files used both by **local Cursor agent sessions**
and as the source of truth for the rules compiled into
`cursor-config/review-rules.md`.

Each skill is maintained independently and covers a focused domain:

| Skill                          | Covers                                                                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `code-review-and-quality/`     | Five-axis review: correctness, readability, architecture, security, performance. Change sizing and review process.                        |
| `nestjs-best-practices/`       | NestJS review guidance in `SKILL.md`: architecture, DI, error handling, security, performance, testing, database, API design, microservices, and DevOps. The detailed per-topic rule files referenced by earlier versions of this skill have been removed. |
| `security-best-practices/`     | Language and framework-specific security guidance. Generates prioritised vulnerability reports.                                           |
| `vercel-react-best-practices/` | React/Next.js performance guidance in `SKILL.md`: waterfall elimination, bundle size, SSR, re-render optimisation, JS perf. The detailed per-topic rule files referenced by earlier versions of this skill have been removed. |

## Keeping rules in sync

`cursor-config/review-rules.md` is injected into the same review prompt
alongside these skill files, not a replacement for them. When you update a
skill file, review whether the corresponding section in `review-rules.md`
also needs updating.

## Copying skill files here

Skills live at your user-level `~/.agents/skills/` and `~/.claude/skills/`.
Copy or symlink them here so they travel with the repo:

```bash
cp ~/.claude/skills/code-review-and-quality/SKILL.md    skills/code-review-and-quality/
cp ~/.claude/skills/nestjs-best-practices/SKILL.md       skills/nestjs-best-practices/
cp ~/.claude/skills/security-best-practices/SKILL.md     skills/security-best-practices/
cp ~/.agents/skills/vercel-react-best-practices/SKILL.md skills/vercel-react-best-practices/
```
