# mdh-mdh — testing plan

Goal: protect what hurts when it breaks — authorization, data integrity, history/rollback, security. Not "every line".
Backend plan: [PLAN.md](PLAN.md).

## Layers

| Layer | What it checks | Tools |
|---|---|---|
| Unit | Path validation, scrypt/HMAC/AES round trips and tampering, cookie sign/verify/expiry, summary text, merge decision, rewind logic, permission rules | vitest |
| Property-based | Random operation sequences (create/edit/rename/delete/upload/rollback). Invariants: rollback(N) gives exactly the state at N; `seq` has no gaps; paths valid and unique; history never shrinks; rollback of a rollback works | fast-check |
| Integration | Real PostgreSQL 18, no database mocks. Each test file gets its own database cloned from a migrated template. Migrations apply from empty and are idempotent; a schema snapshot fails on accidental change. All HTTP endpoints through supertest | vitest, supertest, postgres:18 |
| Permission matrix | Every endpoint x every actor (owner, other user, rw/ro Bearer, rw/ro cookie, wrong password, refreshed old password, anonymous). Expected status is written in the table; an endpoint missing from the table fails the test | vitest |
| Concurrency | Parallel saves of one file (409), parallel creates (unique `seq`), parallel rollbacks, batch upload failing midway (nothing written) | vitest + real DB |
| Security | Path traversal, oversized body, bad JSON, cookie tampering/expiry, brute-force limiter, Origin check, SQL-injection payloads, markdown/XSS payload corpus, passwords never in list responses or logs | vitest |
| Contract | Every `METHOD /api/...` in `llm.txt` exists and answers correctly | vitest |
| Frontend unit | Tree path helpers, markdown sanitizing, share-prompt builder (needs the page script split into pure modules in Milestone 3) | vitest + jsdom |
| E2E | Real browser: register, create project, edit, autosave, upload, rollback, share + gate, unauthorized access, agent flow. Visual regression: light/dark x tiny/default/big | Playwright (Milestone 3/4) |
| Performance | 50 concurrent saves, 2000-file project, 10k-change history; `EXPLAIN` checks that Bearer lookup and history listing use indexes. Budgets are written after measuring, not before | autocannon |
| Mutation | Proves tests catch bugs in crypto, permission, rollback and path modules. Slow: nightly / on demand | Stryker |

## Rules

- Services take an injected `now()`; merge window and cookie expiry are tested with a fake clock, not real waiting.
- Factories (`makeUser`, `makeProject`, `actorAs('rw')`) keep tests short.
- Test database: `DATABASE_URL_TEST` if set, otherwise a throw-away `postgres:18` container started by the test setup.
- Gates: `pnpm test`, `pnpm typecheck` (strict), `pnpm lint`, `pnpm test:coverage`. Coverage floors are in `apps/server/vitest.config.ts` (95% lines, 88% branches overall and on services; `rewind.ts` 100% lines); below them the command fails. Measured now: 99.4% lines, 93.2% branches.
- CI: `.github/workflows/ci.yml` (lint, types, unit tests). Written, never run (no repository). It has no Docker build step yet.
- After each milestone the real command output is reported; anything not run (or not runnable) is stated.

## Dev dependencies

`vitest`, `supertest`, `fast-check`, `@vitest/coverage-v8`, `jsdom`, `eslint`, `typescript-eslint`, `autocannon`. Playwright and Stryker are added in their own phase.

## What exists now (backend)

Run from `apps/server`: `pnpm test`, `pnpm test:coverage`, `pnpm typecheck`, `pnpm lint`. The tests need Docker (they start `postgres:18` themselves) or `DATABASE_URL_TEST` pointing at a Postgres 18 server. `scripts/smoke.sh` checks a running server with curl.

| File | Layer |
|---|---|
| `infra.test.ts` | Postgres 18 + `uuidv7()`, per-test databases, migration runner, `withTx`, config |
| `schema.test.ts` | schema snapshot, every constraint, cascades |
| `crypto.test.ts`, `rate-limit.test.ts` | unit + property (scrypt, HMAC, AES-GCM, signed tokens, limiter) |
| `auth.test.ts` | register / login / session / profile / CSRF / limits / timing |
| `projects.test.ts` | projects, passwords, gate, Bearer, refresh, delete, history numbering and concurrency |
| `permissions.test.ts` | the permission matrix (every route x 9 kinds of caller) and the "every route is covered" check |
| `paths.test.ts`, `rewind.test.ts` | path rules, history math: unit + property |
| `files.test.ts` | read, save (version conflicts, autosave merging), create, move, delete, upload, limits, concurrency |
| `history.test.ts` | listing, paging, one change, rollback, rollback policies |
| `history.property.test.ts` | random operation sequences on a real database; every rollback and every rewind must match a photo of the tree |
| `static.test.ts` | website serving, `/p/*`, dot files, CSP, security headers |
| `download.test.ts` | file, folder and project downloads: exact bytes, names, zip contents (read back with a zip reader), access rules, hostile names |
| `cards.test.ts` | link cards: text layout (property tests), which names can be drawn, XML/HTML escaping (property test), real PNG size, cache, the public name endpoint (name only, 404s, rate limit), page tags for known / unknown / hostile names and Host headers, rename |
| `contract.test.ts` | `llm.txt` vs the real routes, error codes and limits, plus its documented workflow executed end to end |

Mutation checking was done by hand so far: deliberately breaking the code on a copy (about 35 mutations across crypto, sessions, access, files, history and rewind) and confirming a test fails. Two survived at first: (1) an unreachable guard in `authorize` (an equivalent mutant: the line cannot run, so it is only a type guard and has a comment saying so) and (2) the "same time for an unknown user as for a wrong password" protection, which no test measured. (2) got a timing test and is now caught. Stryker is not set up yet.

## What exists now (frontend and end to end)

Frontend unit tests: `cd apps/web && pnpm test` (vitest + jsdom).

| File (`apps/web/test`) | What it protects |
|---|---|
| `api.test.ts` | every API call hits the right method, URL and body; errors become `ApiError`; network failures, non-JSON error pages, `Retry-After` |
| `paths-tree.test.ts` | path helpers, name rules, the file tree rows (folders first, collapsed folders), remapping after rename/delete |
| `autosave.test.ts` | one request at a time, nothing lost, conflict/too-large/network/401/404 behaviour, growing retry wait; a property test with a randomly failing server |
| `upload.test.ts` | reading a dropped folder (batches, hidden entries, unreadable files, depth and count limits) and which files are kept |
| `history.test.ts` | merging a refreshed history page with pages already loaded, never leaving a gap (property test) |
| `mermaid.test.ts` | the placeholder (escaped source), picture width from the viewBox |
| `markdown.test.ts` | an XSS payload list plus a property test: the preview never contains a tag, attribute or link a browser could run |
| `misc.test.ts` | error wording, "access lost" detection, the AI prompt text |

End to end: `pnpm test:e2e` from the repository root (builds, then runs Playwright in `apps/e2e`). It starts a throw-away `postgres:18` and the REAL server serving the built site, so the Content-Security-Policy is active. Specs: `auth-projects`, `editor`, `upload`, `collab` (gate, read-only, edit password, AI agent over HTTP, conflicts, remote deletes, password refresh, rollback policy), `security` (hostile names and markdown, CSP, cross-site writes, owner-only endpoints, cookie flags) and `download`, `mermaid` (drawn under the real CSP, six diagram types, errors, hostile sources, theme change, no flash while typing), `cards` (what a chat app sees without a cookie: tags, picture, no inside information; the logo; the gate names the project), `visual` (screenshots: light/dark, tiny/default/big; the reference images are in `apps/e2e/tests/__screenshots__` and were checked by eye) and `mobile` (a phone profile with touch: every flow by tapping; on every screen and dialog the page must not scroll sideways, every tappable thing must be at least 40 px, text fields at least 16 px; phone screenshots).

The e2e server runs with `TRUST_PROXY=true` and every test comes from its own client address (`X-Forwarded-For`), so per-IP limits never add up across tests and production code has no test-only setting. It also runs with `PUBLIC_DOMAIN` set to a different host name than the browser uses, which proves the Share links use it.

Frontend mutation checking was done by hand on a copy (breaking escaping, autosave flush, polling, conflict notice, gate, rollback button, history details) and confirming an e2e test fails.

Not covered yet: real Safari / iOS (the phone project is Chromium with a phone profile; the owner will try the deployed site on a real phone), the on-screen keyboard, dropping a real FOLDER (the browser's `webkitGetAsEntry` cannot be faked; only the reader logic is unit tested, the real drop must be tried by hand), Firefox and Safari, load tests, running the Docker image, the CI file (never run).
