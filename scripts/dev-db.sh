#!/usr/bin/env bash
# Starts (or restarts) a local PostgreSQL 18 for development: container "mdh-dev-pg" on 127.0.0.1:5433, data in a docker volume.
set -euo pipefail
if docker ps --format '{{.Names}}' | grep -qx mdh-dev-pg; then
  echo "mdh-dev-pg is already running"
elif docker ps -a --format '{{.Names}}' | grep -qx mdh-dev-pg; then
  docker start mdh-dev-pg >/dev/null; echo "started mdh-dev-pg"
else
  docker run -d --name mdh-dev-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=mdh -p 127.0.0.1:5433:5432 -v mdh-dev-pgdata:/var/lib/postgresql postgres:18 >/dev/null
  echo "created mdh-dev-pg"
fi
for _ in $(seq 1 40); do docker exec mdh-dev-pg pg_isready -U postgres -d mdh >/dev/null 2>&1 && break; sleep 1; done
echo "DATABASE_URL=postgres://postgres:dev@127.0.0.1:5433/mdh"
