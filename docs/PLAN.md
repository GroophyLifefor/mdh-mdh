# mdh-mdh — backend plan

Stack: Node.js + Express + TypeScript + raw `pg` (no ORM) on PostgreSQL **18** (needed for the built-in `uuidv7()`).
Testing is a separate document: [TESTING.md](TESTING.md).

## Decisions

- **PostgreSQL 18**, all ids are `uuid DEFAULT uuidv7()`. The project id appears in the URL (`/p/<id>`). It leaks the creation time; access is still protected by the passwords.
- **Passwords find the project.** An agent sends only `Authorization: Bearer <password>`. The project is found from the password, so each project stores an HMAC-SHA256 of each password (unique index) next to the AES-256-GCM encrypted copy (so the owner can copy it again). Refreshing a password changes the hash, so the old one stops working. Gate cookies carry a generation counter (`ro_gen` / `rw_gen`), so refreshing also invalidates old cookies.
- Account passwords: scrypt, per-user salt, `timingSafeEqual`, min 8 chars. Sessions: HMAC-signed httpOnly cookie (stateless; logout cannot revoke a cookie before it expires).
- No access = password gate. There is no public read-only mode.
- Project delete exists (owner only, typed-name confirmation in the UI, cascades). This replaces the earlier "no delete in v1" assumption.

## Schema (plain SQL migrations, tiny runner, no ORM)

- `users` — username (lowercase, unique), scrypt hash, `default_rollback_policy`.
- `projects` — owner, name, `ro_enc`/`rw_enc`, `ro_hash`/`rw_hash` (unique), `ro_gen`/`rw_gen`, `rollback_policy`, `updated_at`.
- `nodes` — `(project_id, path)` unique, kind dir/file, content, `version`. The current tree.
- `changes` — `(project_id, seq)` unique, actor (user/password + name), `kind` (edit/create/rename/delete/upload/rollback), summary, `created_at`, `updated_at`.
- `change_files` — path, action created/updated/deleted, `before`, `after`.

## Rules

- Every mutation runs in one transaction that locks the project row, so `seq` is gap-free.
- **Autosave merging:** same actor + same file + previous change is an `edit` + within 10 minutes => update that change (`after`, `updated_at`) instead of adding a new one.
- **Rollback** never destroys history. Target state = current state rewound with the `before` values of every later change. The diff against the current state is written as a new `rollback` change. Rolling back a rollback works.
- **Conflicts:** saving sends `base_version`; a stale version gets 409.
- **Limits:** 1 MB per file, 200 files per upload, 50 MB and 2000 nodes per project, path depth 20. Paths: no `..`, no empty segments, no control characters, NFC normalized; files must end in .md/.yml/.yaml.
- **Rate limit** (in-memory) on login and password attempts. Single process only; noted as a limit.
- Cookie auth: SameSite=Lax + Origin check on mutating requests. Bearer requests are exempt.
- `APP_SECRET` is required (min 32 chars) or the server refuses to start.

## API (`/api`)

| Area | Endpoints |
|---|---|
| auth | `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `PATCH /auth/me` |
| projects | `GET /projects`, `POST /projects`, `GET /projects/:id`, `PATCH /projects/:id`, `DELETE /projects/:id` |
| passwords | `GET /projects/:id/passwords` (owner), `POST /projects/:id/passwords/:mode/refresh` |
| access | `POST /projects/:id/access` (gate), `GET /access` (Bearer: who am I, which project, which level) |
| config | `GET /config` (public: `{ publicUrl }`) |
| files | `GET /projects/:id/tree`, `GET /projects/:id/download?path=` (a file, a folder as .zip, or no path: the whole project as .zip), `GET /projects/:id/file?path=`, `PUT /projects/:id/file`, `POST /projects/:id/files` (create), `POST /projects/:id/move`, `DELETE /projects/:id/file?path=`, `POST /projects/:id/upload` |
| history | `GET /projects/:id/history`, `GET /projects/:id/history/:seq`, `POST /projects/:id/history/:seq/rollback` |

`/llm.txt` describes this API for agents and is checked against the real routes by a contract test.

## Layout

`apps/server/src`: `config`, `db`, `migrate` (+ `migrations/*.sql`), `crypto`, `session`, `access`, `errors`, `routes/*` (thin), `services/*` (transactions), `app.ts` (`createApp()` factory used by tests), `index.ts`.

## Order (each step verified before the next)

1. Server skeleton + test harness (first test: Postgres 18 `uuidv7()` works).
2. Schema + migrations.
3. Crypto, sessions, auth.
4. Projects, passwords, access, delete.
5. Files, changes, merging, history, rollback, upload.
6. `llm.txt`, contract test, `scripts/smoke.sh` (curl scenario).
7. Then: search + delete in "Your projects" UI, Milestone 3 (wire the frontend), Milestone 4 (Docker + README).

## Decisions made while building (these refine the plan above)

- **Folder names cannot end in .md/.yml/.yaml** (service check and a database constraint). A path is then always exactly one kind, which keeps history rows unambiguous.
- **Every folder has its own row** in `nodes`; missing folders are created on the way by create, move and upload.
- **No access, or no such project, looks the same:** `401 password_required`, so ids cannot be probed. A valid password for another project is also `password_required`; a wrong or refreshed Bearer is `401 invalid_token`.
- **Owner = the signed-in session user only.** A project password can never read passwords, change settings or delete the project.
- **Rollback policy:** `author_and_write` = the owner and anyone with a read-write password; `author_only` = only the project owner (the signed-in account that owns it). A password, even read-write, is never the owner. Read-only can never roll back.
- **Autosave merging is server-side** (same actor + same file + latest entry is an edit + under 10 minutes). An edit typed back to the original text stays as an entry with equal before/after, because history never shrinks.
- **Upload is all-or-nothing**; existing files with different content need `overwrite: true`, otherwise 409 `conflicts` lists them.
- **`X-Actor-Name`** lets an agent put a name on its changes ("pw: name").
- **Wrong passwords share one limiter per IP** (gate and Bearer): 30 per 15 minutes. Failed logins: 10 per 15 minutes. Sign-ups: 20 per hour.
- **Security headers and a strict CSP** are sent with the pages; the CSP allows exactly the inline scripts found in the built HTML (hashed at startup).
- **TypeScript 7** compiles (`tsc`); `typescript-eslint` still needs the TS 6 API, so `typescript` is aliased to `@typescript/typescript6` and TS 7 is installed as `@typescript/native`.

## Status

- **Backend (steps 1-6):** done and verified, see TESTING.md.
- **Milestone 3 (frontend wired to the API):** done.
- **Added after Milestone 3:** `PUBLIC_DOMAIN` (optional; see below), file / folder / whole-project download as .zip, history panel closed by default, save when the tab is closed, and a real phone layout (tabs for Files / Editor / History, row menu instead of hover buttons, upload button, 44 px touch targets, 16 px text fields).
- **Milestone 4 (Docker image, compose, README):** done. The image builds, `docker compose up` gives two healthy containers, `scripts/smoke.sh` passes 40/40 against it, data survives a restart.

## One domain is enough

In production ONE process serves the API and the built website, so one domain (one port) is all that is needed. The two-process setup (website dev server + API server with a `/api` proxy) exists only for `pnpm dev`.

## PUBLIC_DOMAIN (optional)

`mdh.example.com` (https is assumed) or `http://localhost:3000`. The server reads it; the website asks the server (`GET /api/config`, since a static page cannot read server settings). Used for the links in the Share dialog and the AI prompt, as an allowed origin in the cross-site check (so it works behind a proxy that rewrites Host), and to turn on Secure cookies when it is https (there is no separate setting). Without it the address of the browser tab is used. A bad value stops the server at start-up with an explanation.

## Known limits

- Logout cannot revoke a stateless cookie before expiry.
- The rate limiter is per process.
- Changes by other people are noticed by looking every 10 s, not instantly (no websockets).
- Dropping a real folder works through the browser's `webkitGetAsEntry`; it is unit tested with fake entries but has not been tried with a real drop.
- Not tried: a build on another machine / CPU architecture, or behind a real reverse proxy.
- No git repository yet; nothing is committed or pushed.
- `.github/workflows/ci.yml` is written but has never run.
