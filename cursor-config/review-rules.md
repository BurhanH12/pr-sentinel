# PR Review Rules — NestJS & Next.js Projects

These rules are injected verbatim into the Cursor PR review agent's prompt.
Per-repo overrides: commit `.cursor/review-rules.md` (rules text only) or
`.cursor/review-rules.json` (full config) in the target repo.

---

## How to approach this review

You have full read access to the repository working copy. **Use it actively.**
Before judging any change, open the surrounding files to understand the existing
patterns in this specific codebase. The goal is not just to apply generic rules
but to ensure the PR is consistent with how this project is already built.

Specifically, before writing findings:

1. Read the files adjacent to the changed ones to understand established conventions.
2. Identify the project's existing patterns for: folder structure, naming, state
   management, API integration, error handling, type definitions, and component
   design.
3. Then evaluate the PR changes against those patterns — not against a generic
   idealised standard.

Approve changes that clearly improve code health even if imperfect. Only flag
what you can point at in the diff or the file tree. Do not invent issues.

---

## 1. Project consistency

These are the most important checks because they are specific to this codebase.

- **Folder structure** — Flag files placed in the wrong directory for this
  project's module layout (e.g. a service in a controller folder, a util in a
  feature module).
- **Naming conventions** — Flag names that break the pattern used by existing
  files in the same directory (casing, suffixes like `.service.ts`, `.hook.ts`,
  `.slice.ts`, etc.).
- **State management** — Flag new local state or data-fetching that duplicates
  or conflicts with the approach already in use (e.g. introducing Redux when the
  project uses Zustand, or raw `useState` where a shared store already exists).
- **API integration patterns** — Flag direct `fetch`/`axios` calls that bypass
  the project's existing API layer or service abstraction.
- **Reusable component patterns** — Flag new components that re-implement
  something already in the shared component library or a nearby folder.
- **Error handling strategy** — Flag error handling that differs from the
  established approach without justification (e.g. swallowing errors where the
  project always surfaces them, or using a different error class hierarchy).
- **Type definitions** — Flag types or interfaces that duplicate existing ones,
  or inline types that should extend a shared base type already in the codebase.
- **Module design alignment** — Flag a new module, service, or feature that
  diverges from how the rest of the project organises the same concept.
- **Irregularities** — Flag anything that "feels off" relative to the
  surrounding code: unexplained style jumps, sudden framework switches, logic
  that is inconsistent with nearby code for no apparent reason.

---

## 2. Correctness

- Flag missing error handling in `async`/`await` paths — unhandled rejections,
  missing `try/catch`, promises fired without being awaited.
- Flag missing or inadequate input validation — edge cases, null/undefined
  inputs, empty arrays, boundary values not handled.
- Flag potential race conditions: shared mutable state accessed concurrently,
  async operations that depend on ordering but have no guard.
- Flag new public functions or API endpoints with no accompanying tests.
- Flag tests with no assertions (empty `it()` blocks, `expect()` without a
  matcher).
- Flag any TODO or FIXME comments _introduced_ in this PR (not pre-existing).

---

## 3. Code Quality & Readability

- Flag violations of **Single Responsibility**: a function, class, or component
  that does more than one distinct thing and could reasonably be split.
- Flag **over-engineering and premature abstraction**: generic factories,
  registries, or plugin systems introduced for a single use case; abstraction
  layers that add indirection without a second consumer.
- Flag **unnecessary defensive code**: null checks on values that are
  structurally guaranteed non-null, try/catch around code that cannot throw,
  feature flags that are always on, fallback branches that can never execute.
- Flag functions longer than 50 lines that could reasonably be split.
- Flag deeply nested conditionals (>3 levels) that meaningfully reduce
  readability.
- Flag DRY violations: copy-pasted code blocks that belong in a shared utility.
- Flag non-descriptive names (`data`, `result`, `temp`, `obj`) in public APIs.
- Flag dead code: unused variables, unreachable branches, commented-out code,
  stale abstractions that no longer have callers, backwards-compat shims for
  code that was already removed.
- Flag `any` usage in TypeScript without an inline justification comment.
- Flag unsafe type assertions (`as SomeType`) that bypass proper type narrowing.
- Flag missing return-type annotations on exported public functions.
- Flag `@ts-ignore` / `@ts-expect-error` without an explanation.
- Flag new public APIs with no JSDoc.
- Flag environment variables used in code not documented in `.env.example`.

---

## 4. Security

### Universal

- Flag hardcoded secrets, tokens, passwords, or API keys.
- Flag injection risks from string concatenation in SQL/NoSQL/LDAP queries.
- Flag `eval()`, `exec()`, `new Function()`, or dynamic `require()` / `import()`.
- Flag `Math.random()` used for anything security-sensitive.
- Flag missing authentication or authorisation checks on new endpoints.
- Flag missing input validation on public-facing handlers.
- Flag insecure cookie flags (`httpOnly`, `sameSite`, `secure`).
- Flag auto-incrementing integer IDs in public URLs — prefer UUID v4.

<!-- stack: nestjs -->
### NestJS-specific

- Flag controllers or resolvers missing `@UseGuards()` where the route is not
  explicitly public.
- Flag `ValidationPipe` without `whitelist: true` and `forbidNonWhitelisted: true`.
- Flag JWT secrets in code instead of `ConfigService` / env.
- Flag missing rate limiting (`@nestjs/throttler`) on auth endpoints.
- Flag GraphQL resolvers missing object-level authorisation before querying.
<!-- /stack -->

<!-- stack: nextjs -->
### Next.js-specific

- Flag Server Actions that do not verify the caller's session before mutating.
- Flag Route Handlers that read body or query params without boundary validation.
- Flag `dangerouslySetInnerHTML` with unsanitized input.
<!-- /stack -->

---

## 5. Performance

### Universal

- Flag N+1 query patterns: queries inside loops, missing `JOIN`/`include`.
- Flag missing pagination on list endpoints.
- Flag synchronous file I/O (`readFileSync`, `writeFileSync`) in handlers.
- Flag CPU-intensive work in hot paths that should run in a worker or be
  offloaded.

<!-- stack: nestjs -->
### NestJS-specific

- Flag async lifecycle hooks (`onModuleInit`, `onApplicationBootstrap`) missing
  `await` on their async operations.
- Flag missing caching on expensive read-only endpoints.
- Flag `findMany`/`findAll` without `select`/`include` — fetching unused columns.
- Flag heavy modules that could be lazy-loaded.
<!-- /stack -->

<!-- stack: nextjs,react -->
### Next.js / React

- Flag sequential `await` calls for independent operations — use `Promise.all()`.
- Flag barrel-file imports (`import { X } from '@/components'`).
- Flag heavy components not wrapped in `next/dynamic` when not needed on first
  paint.
- Flag `useEffect` that re-fetches due to non-primitive dependency arrays.
- Flag inline component definitions inside another component's render body.
- Flag `&&` conditional JSX where the left-hand side can be `0`.
<!-- /stack -->

---

## 6. Architecture

<!-- stack: nestjs -->
### NestJS

- Flag circular module dependencies.
- Flag "god services" spanning more than one feature domain (SRP).
- Flag database logic in controllers — it belongs in a service or repository.
- Flag providers used across modules but not exported from their module.
- Flag `new SomeService()` instead of DI.
- Flag mutable module-level state in singleton services.
- Flag multi-table write operations missing a database transaction.
<!-- /stack -->

<!-- stack: nextjs -->
### Next.js

- Flag `async function` on a `'use client'` component.
- Flag non-serialisable props (functions, class instances, Dates) crossing the
  RSC boundary.
- Flag `useSearchParams()` / `usePathname()` outside a Suspense boundary.
- Flag data fetching in a Client Component that belongs in a Server Component.
- Flag `params` / `searchParams` not awaited in `page.tsx` / `layout.tsx`
  (async in Next.js 15+).
- Flag `cookies()` / `headers()` not awaited.
- Flag Route Handler `GET` defined in the same file as `page.tsx`.
<!-- /stack -->

---

## 7. Dependency hygiene

- Flag new dependencies without visible justification.
- Flag dependencies that duplicate something already in the stack.
- Flag major version bumps with no migration note.

---

## Severity guide

| Severity | Definition                                                                      |
| -------- | ------------------------------------------------------------------------------- |
| critical | Security vulnerability, data loss risk, production-outage potential             |
| high     | Likely bug, broken auth check, serious performance regression, race condition   |
| medium   | Consistency violation, SRP breach, over-engineering, unnecessary defensive code |
| low      | Style issue, naming, minor improvement                                          |
| info     | Observation with no action required                                             |
