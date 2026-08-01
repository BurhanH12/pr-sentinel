# Review Skills

This directory holds the SKILL.md files used both by **local Cursor agent sessions**
and as the source of truth for the rules compiled into
`cursor-config/review-rules.md`.

Each skill is maintained independently and covers a focused domain:

| Skill                          | Covers                                                                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `code-review-and-quality/`     | Five-axis review: correctness, readability, architecture, security, performance. Change sizing and review process.                        |
| `nestjs-best-practices/`       | 40 NestJS rules across architecture, DI, error handling, security, performance, testing, database, API design, microservices, and DevOps. |
| `security-best-practices/`     | Language and framework-specific security guidance. Generates prioritised vulnerability reports.                                           |
| `next-best-practices/`         | Next.js 15+ patterns: RSC boundaries, async API changes, file conventions, runtime selection, hydration errors.                           |
| `vercel-react-best-practices/` | 70 React/Next.js performance rules: waterfall elimination, bundle size, SSR, re-render optimisation, JS perf.                             |

## Keeping rules in sync

`cursor-config/review-rules.md` is injected into the same review prompt
alongside these skill files, not a replacement for them. When you update a
skill file, review whether the corresponding section in `review-rules.md`
also needs updating.

## Copying skill files here

Skills live at your user-level `~/.agents/skills/` and `~/.claude/skills/`.
Copy or symlink them here so they travel with the repo:

```bash
cp -r ~/.claude/skills/code-review-and-quality   skills/
cp -r ~/.claude/skills/nestjs-best-practices      skills/
cp -r ~/.claude/skills/security-best-practices    skills/
cp -r ~/.agents/skills/next-best-practices        skills/
cp -r ~/.agents/skills/vercel-react-best-practices skills/
```
