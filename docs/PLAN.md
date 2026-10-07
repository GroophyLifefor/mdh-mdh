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
| public | `GET /projects/:id/public` (the name only; anyone who knows the id) |
| files | `GET /projects/:id/tree`, `GET /projects/:id/download?path=` (a file, a folder as .zip, or no path: the whole project as .zip), `GET /projects/:id/file?path=`, `PUT /projects/:id/file`, `POST /projects/:id/files` (create), `POST /projects/:id/move`, `DELETE /projects/:id/file?path=`, `POST /projects/:id/upload` |
| history | `GET /projects/:id/history`, `GET /projects/:id/history/:seq`, `GET /projects/:id/history/:seq/file?path=` (one file before / after, for the diff view), `POST /projects/:id/history/:seq/rollback` |

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
- **No access, or no such project, looks the same:** `401 password_required` on every endpoint that reads or changes a project. A valid password for another project is also `password_required`; a wrong or refreshed Bearer is `401 invalid_token`.
- **The project NAME is public to anyone who knows the id; nothing else is** (decided by the owner). `GET /api/projects/:id/public` returns `{ name }` (404 for an unknown or malformed id, limited to 120 requests per minute per IP). So the existence of an id can be tested, which is acceptable because ids are uuidv7 (74 random bits). The name is used for link cards and the password gate.
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

## Landing page

`components/Landing.astro`, shown to visitors who are not signed in (`body.on-landing`). One sentence of story ("Your workspace, shared with your agents."), the name is only mdh-mdh. All pictures are real screenshots of the app made by `apps/e2e/tests/landing-shots.spec.ts` from a small staged demo project (run by hand: `LANDING_SHOTS=1 npx playwright test tests/landing-shots.spec.ts --project=chromium`; the times in the history and the address in the Share dialog are staged). Each picture exists in a light and a dark version; only the one for the current theme is displayed, and because they are lazy only that one is fetched. The pictures must be made again when the interface changes.

## Link cards and the logo

Chat apps fetch a pasted link without cookies, so the server fills the `<head>` of the pages at request time (`services/head.ts`): `og:*`, `twitter:card=summary_large_image`, `description`, and for `/p/<id>` the project name (escaped) with `noindex`. Absolute urls come from `PUBLIC_DOMAIN`, else from the request's Host (only a plausible host name is trusted). `GET /og/<id>.png` and `/og/default.png` draw a 1200 x 630 card with `@resvg/resvg-js` and Inter (`apps/server/assets/fonts`, SIL OFL); renders are cached in memory (200 entries, key = id + name, so a rename shows at once), an unknown id costs no render. Names the font cannot draw (other scripts, emoji) get a plain card; the `og:title` still carries the real name. The brand mark is `favicon.svg`, `apple-touch-icon.png` and the `LogoMark` component (follows the theme); the original `logo*.svg` files are left untouched (they embed c2pa metadata and fixed black strokes).

## Links and the diff view

The address follows what is open: `/p/<id>?file=notes/a.md` (written with `replaceState`, so the back button is not filled), and `?diff=<seq>&dpath=<file>` for the diff modal. A person with the link goes through the password gate first (any password: looking at a diff is a read), then lands on the same view. `GET /history/:seq/file` gives one file's `before` and `after` (null where it did not exist; folders have none); one file at a time keeps the answer small (an upload can touch 200 files of 1 MB). The diff is drawn by `lib/diff.ts` (own Myers line diff, 3 lines of context; two completely different big files fall back to "all removed, all added"). A final line break does not count as an extra line. The file list of a change is a tree like the Files panel (`lib/difftree.ts`): chains of single folders are one row (the last folder stays readable, the part before it is dimmed and shortened first), rows show the file NAME with a +, ~ or − mark (full path in the tooltip), and there is a "3 / 27" line with previous / next (left / right arrow keys; on a phone the name opens the list).

Because autosaves of one person in one file within 10 minutes are ONE history entry, a diff shows the net change of that editing session, and the link of the newest entry can still grow while the session lasts. The modal says "edited between 12:01 and 12:09" when an entry spans time. Rejected: freezing an entry when its link is copied (a view-only visitor would write), keeping a snapshot per autosave (the database growth we avoided).

## Scrolling together (split mode)

The editor and the preview are tied by ANCHORS, not by percentage (a percentage drifts at every tall code block, table or diagram). `renderMarkdownLines` marks each top-level block of the preview with `data-line="N"`, the source line it starts at; `lib/scrollsync.ts` turns the measured blocks into anchors (line, pixel position) with a start and an end, and interpolates linearly between two anchors in both directions. The editor side is read from CodeMirror as a fractional line (long lines wrap, so lines have different heights). The ends are special: at the very top or bottom of one side the other side is also at its top or bottom. A scroll that we caused ourselves is remembered and not answered. The preview is aligned again when it is redrawn and when a diagram or picture finishes loading (Safari has no scroll anchoring of its own; the e2e test switches Chrome's off to stand in for it).

## Rich diff of markdown

A `.md` file's diff is shown as the page by default (`Rendered | Source` switch, remembered per browser; yaml and files over 300 000 characters per side are shown as lines). `lib/richdiff.ts` splits both texts into top-level blocks with `marked`, aligns them with the same Myers code as the line diff (`align` in `lib/diff.ts`), pairs a removed and an added block of the same kind when they share enough words (addresses of links and pictures do not count as words; the same address with a new description still pairs), and marks the changed words inside a pair with `<ins>` / `<del>` by diffing the text nodes of the two rendered blocks. Green bar = new section, red = removed, amber = changed; long unchanged stretches are folded. A new or deleted file is shown as a plain page. Pictures are never loaded; in the diff they are visible labels "Image: description (address)" so adding, removing, renaming or re-addressing one can be seen (the normal preview still shows the description only). A changed mermaid diagram shows the old picture (red) above the new one (green) because its source cannot be marked word by word; diagrams in folded sections are drawn when the fold opens. Everything shown goes through the same sanitising renderer as the preview; the wrappers, `<ins>` and `<del>` are made with DOM calls.

## Mermaid diagrams

A ```mermaid block in the preview is drawn by `apps/web/src/lib/mermaid.ts`. The library loads only when a block exists (own chunks, same origin, so the CSP is unchanged). Two layers keep other people's diagrams harmless: mermaid's `securityLevel: 'strict'`, and the result is shown as `<img src="data:image/svg+xml,...">`, where an SVG can never run a script. Results are cached per theme + source; a theme change draws them again. Limits: text inside a diagram cannot be selected, a very wide diagram is scaled down to the screen, only the common types were tried (flow, sequence, class, state, ER, gantt, pie).

## One domain is enough

In production ONE process serves the API and the built website, so one domain (one port) is all that is needed. The two-process setup (website dev server + API server with a `/api` proxy) exists only for `pnpm dev`.

## PUBLIC_DOMAIN (optional)

`mdh.example.com` (https is assumed) or `http://localhost:3000`. The server reads it; the website asks the server (`GET /api/config`, since a static page cannot read server settings). Used for the links in the Share dialog and the AI prompt, as an allowed origin in the cross-site check (so it works behind a proxy that rewrites Host), and to turn on Secure cookies when it is https (there is no separate setting). Without it the address of the browser tab is used. A bad value stops the server at start-up with an explanation.

## Known limits

- Logout cannot revoke a stateless cookie before expiry.
- The rate limiter is per process.
- Changes by other people are noticed by looking every 10 s, not instantly (no websockets).
- Dropping a real folder works through the browser's `webkitGetAsEntry`; it is unit tested with fake entries but has not been tried with a real drop.
- The rich diff pairs blocks by shared words, which can misjudge (a moved paragraph is removed + added; a list with one more item is one changed block, not one bar per item).
- The diff of a very long file shows at most 3000 rows; a final line break added at the end of a file is not shown as a change.
- Link cards are tested against our own HTML and PNG, not against real Slack / WhatsApp / Discord (they also cache cards for a long time).
- Not tried: a build on another machine / CPU architecture, or behind a real reverse proxy.
- No git repository yet; nothing is committed or pushed.
- `.github/workflows/ci.yml` is written but has never run.
