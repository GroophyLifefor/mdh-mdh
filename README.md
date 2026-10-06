# mdh-mdh

Self-hosted workspaces for Markdown and YAML files. Projects hold folders and `.md` / `.yml` / `.yaml` files stored in PostgreSQL, with history and rollback, password-based sharing (read-only or edit) and a ready-made prompt that lets an AI agent work in a project through the API (`/llm.txt`).

## Run it (Docker)

You need Docker with Compose.

```bash
cp .env.example .env     # then edit: POSTGRES_PASSWORD, APP_SECRET, PUBLIC_DOMAIN
docker compose up -d --build
```

Open `http://localhost:3000` (or your `PORT`). The host port comes from `docker-compose.override.yml`, which Compose reads automatically for local use; the main `docker-compose.yml` publishes no port, so a reverse proxy (Coolify, Caddy, ...) is the only way in when you deploy it. One container serves the website and the API; PostgreSQL 18 runs in a second one with its data in the `dbdata` volume. Tables are created on start.

Pasted links get a preview card (name of the project and a picture). Only the **name** of a project is visible to someone who has the link; files and passwords are not.

## Settings (`.env`)

| Name | Required | What it does |
|---|---|---|
| `POSTGRES_PASSWORD` | yes | Password of the bundled database. |
| `APP_SECRET` | yes, 32+ characters | Signs cookies and encrypts project passwords. Changing it logs everyone out and makes stored project passwords unreadable, so back it up. |
| `PUBLIC_DOMAIN` | no | The address people use: `mdh.example.com` (https assumed) or `http://localhost:3000`. Used for the links in the Share dialog and the AI prompt. An https address also turns on Secure cookies. Without it the address in the browser tab is used. |
| `TRUST_PROXY` | no, default `false` | Set `true` only when a reverse proxy (Caddy, nginx, Traefik) sits in front and sets `X-Forwarded-For` / `X-Forwarded-Host`. Then login limits count real client addresses. Leave `false` when the container is exposed directly: otherwise anyone could fake those headers. |
| `PORT` | no, default `3000` | Port on the host, local use only. |

## On a real domain

Coolify: point the `app` service's domain at port 3000 (`https://mdh.example.com:3000`), set `TRUST_PROXY=true`, `PUBLIC_DOMAIN`, `APP_SECRET` and `POSTGRES_PASSWORD`. Do not publish a host port.

Put a reverse proxy in front for https, and set `PUBLIC_DOMAIN=mdh.example.com` and `TRUST_PROXY=true`. One domain is enough: the same process serves the site and the API. Example with Caddy:

```
mdh.example.com {
  reverse_proxy localhost:3000
}
```

## Backup

Back up the database and `APP_SECRET` together:

```bash
docker compose exec db pg_dump -U mdh mdh > mdh-backup.sql
```

## Development

Needs Node 26, pnpm 12 and Docker (for the test database).

```bash
pnpm install
pnpm dev:db          # PostgreSQL 18 on 127.0.0.1:5433
cp apps/server/.env.example apps/server/.env
pnpm dev             # API on :3000, website dev server with an /api proxy
pnpm test            # server + web unit tests (starts its own postgres:18)
pnpm test:e2e        # real browser tests against the production setup
pnpm typecheck && pnpm lint
./scripts/smoke.sh http://localhost:3000   # curl check against a running server
```

Plans and test strategy: [docs/PLAN.md](docs/PLAN.md), [docs/TESTING.md](docs/TESTING.md).

## Known limits

- Logging out cannot revoke a cookie before it expires (stateless sessions).
- Login limits are kept in memory, per process.
- Changes by other people appear within about 10 seconds (polling, no websockets).
