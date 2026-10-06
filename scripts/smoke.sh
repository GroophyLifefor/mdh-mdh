#!/usr/bin/env bash
# End-to-end check against a RUNNING server, using only curl and jq (what an agent would use).
# usage: scripts/smoke.sh [base-url]      (default http://localhost:3000)
set -uo pipefail
BASE="${1:-http://localhost:3000}"
JAR="$(mktemp)"; trap 'rm -f "$JAR"' EXIT
FAILED=0; STEP=0
USER="smoke$(date +%s%N | tail -c 9)"

ok()   { STEP=$((STEP+1)); printf '  ok   %2d  %s\n' "$STEP" "$1"; }
fail() { STEP=$((STEP+1)); FAILED=$((FAILED+1)); printf '  FAIL %2d  %s\n         %s\n' "$STEP" "$1" "${2:-}"; }
# expect <description> <expected> <actual>
expect() { if [ "$2" == "$3" ]; then ok "$1"; else fail "$1" "expected [$2] got [$3]"; fi; }

# req <method> <path> [curl args...]  -> sets BODY and CODE
req() { local m="$1" p="$2"; shift 2; local out; out="$(curl -s -o /dev/stderr -w '%{http_code}' -X "$m" "$BASE$p" "$@" 2>/tmp/smoke_body)"; CODE="$out"; BODY="$(cat /tmp/smoke_body)"; }
json() { printf '%s' "$BODY" | jq -r "$1"; }

echo "mdh-mdh smoke test against $BASE"
req GET /api/health;                                   expect "health" "200" "$CODE"
req GET /llm.txt;                                      expect "llm.txt is served" "200" "$CODE"
case "$BODY" in *"Authorization: Bearer"*) ok "llm.txt explains Bearer";; *) fail "llm.txt explains Bearer";; esac
req GET /p/some-id;                                    expect "project page is served for /p/<id>" "200" "$CODE"
case "$BODY" in *"<html"*) ok "it is html";; *) fail "it is html" "${BODY:0:80}";; esac

# --- account and project (as a person) ---
req POST /api/auth/register -c "$JAR" -H 'content-type: application/json' -d "{\"username\":\"$USER\",\"password\":\"smoke-password\"}"
expect "register" "201" "$CODE"
req POST /api/auth/register -H 'content-type: application/json' -d "{\"username\":\"$USER\",\"password\":\"smoke-password\"}"
expect "same username again is refused" "409" "$CODE"
req POST /api/projects -b "$JAR" -H 'content-type: application/json' -d '{"name":"Smoke test"}'
expect "create project" "201" "$CODE"; PID="$(json .project.id)"
req GET "/api/projects/$PID/passwords" -b "$JAR";      expect "owner reads the passwords" "200" "$CODE"
RW="$(json .rw)"; RO="$(json .ro)"
case "$PID" in ????????-????-7???-*) ok "project id is a uuidv7";; *) fail "project id is a uuidv7" "$PID";; esac
req GET /api/projects -b "$JAR";                       expect "project shows in my list" "$PID" "$(json '.projects[0].id')"

# --- as an agent: only the password ---
AUTH=(-H "Authorization: Bearer $RW" -H 'X-Actor-Name: smoke-agent' -H 'content-type: application/json')
req GET /api/access "${AUTH[@]}";                      expect "whoami: level" "rw" "$(json .level)"
expect "whoami: project id" "$PID" "$(json .project.id)"
req GET "/api/projects/$PID/tree" "${AUTH[@]}";        expect "tree has readme.md" "readme.md" "$(json '.nodes[0].path')"
req GET "/api/projects/$PID/file?path=readme.md" "${AUTH[@]}"; V="$(json .file.version)"
req PUT "/api/projects/$PID/file" "${AUTH[@]}" -d "{\"path\":\"readme.md\",\"content\":\"# edited by an agent\",\"baseVersion\":$V}"
expect "save with the right version" "200" "$CODE"
req PUT "/api/projects/$PID/file" "${AUTH[@]}" -d "{\"path\":\"readme.md\",\"content\":\"stale\",\"baseVersion\":$V}"
expect "save with a stale version is a conflict" "409" "$CODE"
req POST "/api/projects/$PID/upload" "${AUTH[@]}" -d '{"files":[{"path":"docs/a.md","content":"A"},{"path":"docs/sub/b.yml","content":"b: 1"}],"folders":["empty"]}'
expect "upload a directory" "200" "$CODE"; expect "upload creates 2 files" "2" "$(json .created)"
req POST "/api/projects/$PID/upload" "${AUTH[@]}" -d '{"files":[{"path":"docs/a.md","content":"CHANGED"}]}'
expect "upload over existing content needs overwrite" "409" "$CODE"
req POST "/api/projects/$PID/move" "${AUTH[@]}" -d '{"from":"docs","to":"manual"}';  expect "rename a folder" "200" "$CODE"
req DELETE "/api/projects/$PID/file?path=manual/sub" "${AUTH[@]}";                  expect "delete a folder" "200" "$CODE"
req GET "/api/projects/$PID/history" "${AUTH[@]}"
expect "history is attributed to the agent" "pw: smoke-agent" "$(json '.changes[0].actor.label')"
expect "history lists every change (the refused upload left no entry)" "5" "$(json '.changes | length')"
req POST "/api/projects/$PID/history/1/rollback" "${AUTH[@]}"; expect "roll back to the first state" "200" "$CODE"
req GET "/api/projects/$PID/tree" "${AUTH[@]}";        expect "tree is back to one file" "1" "$(json '.nodes | length')"
req POST "/api/projects/$PID/history/1/rollback" "${AUTH[@]}"; expect "rolling back to where we are is refused" "409" "$CODE"
req GET "/api/projects/$PID/history" "${AUTH[@]}";     expect "the rollback is a new change (history only grows)" "6" "$(json '.changes | length')"

# --- read-only password ---
RO_AUTH=(-H "Authorization: Bearer $RO" -H 'content-type: application/json')
req GET "/api/projects/$PID/tree" "${RO_AUTH[@]}";     expect "read-only can read" "200" "$CODE"
req POST "/api/projects/$PID/files" "${RO_AUTH[@]}" -d '{"path":"x.md","kind":"file"}'; expect "read-only cannot write" "403" "$CODE"
req DELETE "/api/projects/$PID" "${AUTH[@]}";          expect "a project password cannot delete the project" "403" "$CODE"
req GET /api/access -H 'Authorization: Bearer rw_wrongwrongwrongwrong1234';  expect "wrong password" "401" "$CODE"

# --- gate (a person without an account) ---
req POST "/api/projects/$PID/access" -c "$JAR.gate" -H 'content-type: application/json' -d "{\"password\":\"$RW\",\"name\":\"Sam\"}"
expect "gate with the password" "200" "$CODE"
req GET "/api/projects/$PID" -b "$JAR.gate";           expect "gate cookie gives access" "rw" "$(json .access.level)"; expect "gate keeps the name" "Sam" "$(json .access.name)"

# --- refresh invalidates ---
req POST "/api/projects/$PID/passwords/rw/refresh" -b "$JAR"; expect "refresh the password" "200" "$CODE"; NEW="$(json .password)"
req GET /api/access "${AUTH[@]}";                      expect "the old password stops working" "401" "$CODE"
req GET "/api/projects/$PID" -b "$JAR.gate";           expect "the old gate cookie stops working" "401" "$CODE"
req GET /api/access -H "Authorization: Bearer $NEW";   expect "the new password works" "rw" "$(json .level)"

# --- delete ---
req DELETE "/api/projects/$PID" -b "$JAR";             expect "owner deletes the project" "200" "$CODE"
req GET /api/access -H "Authorization: Bearer $NEW";   expect "its password is gone" "401" "$CODE"
rm -f "$JAR.gate" /tmp/smoke_body

echo
if [ "$FAILED" -eq 0 ]; then echo "ALL $STEP CHECKS PASSED"; else echo "$FAILED of $STEP CHECKS FAILED"; exit 1; fi
