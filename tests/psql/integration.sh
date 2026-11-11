#!/bin/sh
# End-to-end, everything real except Kaneo itself: throwaway Postgres database,
# this image's migration, the actual hub process, the real pg driver, and a mock
# admin API. Inserts an account and checks it lands in the workspace.
#
#   PGPASSWORD=test PGHOST=127.0.0.1 PGPORT=55432 PGUSER=kaneo sh tests/psql/integration.sh
set -u

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DB=kaneo_labs_e2e
API_PORT=${API_PORT:-8997}
HEALTH_PORT=${HEALTH_PORT:-8098}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/labs-e2e.XXXXXX") || exit 1
FAIL=0
trap 'rm -rf "$WORK"' EXIT INT TERM

DATABASE_URL="postgres://${PGUSER:-kaneo}:${PGPASSWORD:-test}@${PGHOST:-127.0.0.1}:${PGPORT:-55432}/$DB"

echo "postgres: $(psql -X -tAc 'select version()' -d postgres | cut -c1-40)"
psql -X -q -d postgres -c "DROP DATABASE IF EXISTS $DB" >/dev/null 2>&1
psql -X -q -d postgres -c "CREATE DATABASE $DB" >/dev/null || exit 1
psql -X -q -d "$DB" -c 'CREATE TABLE "user" (id text PRIMARY KEY, email text NOT NULL,
  is_anonymous boolean DEFAULT false, banned boolean DEFAULT false, role text,
  created_at timestamptz NOT NULL DEFAULT now());' >/dev/null

echo "== migrating (this also proves the migration runner) =="
DATABASE_URL="$DATABASE_URL" LOG_LEVEL=info node "$ROOT/src/cli/migrate.ts" > "$WORK/migrate.log" 2>&1
MIGRATE_EXIT=$?
sed 's/^/  /' "$WORK/migrate.log"
[ $MIGRATE_EXIT -eq 0 ] || { echo "  FAIL  migrate exited $MIGRATE_EXIT"; exit 1; }
APPLIED=$(psql -X -tAc "select count(*) from labs_automation_migration" -d "$DB")
echo "  recorded migrations: $APPLIED"

echo "== starting the sidecar =="
PORT="$API_PORT" EXPECT_TOKEN=tok node "$ROOT/tests/support/mock-kaneo.ts" > "$WORK/mock.log" 2>&1 &
MPID=$!
sleep 1

env AUTOMATIONS=auto-join \
    KANEO_API_URL="http://127.0.0.1:$API_PORT" \
    KANEO_WORKSPACE_ID=ws1 \
    KANEO_ADMIN_TOKEN=tok \
    DATABASE_URL="$DATABASE_URL" \
    HEALTH_PORT="$HEALTH_PORT" \
    RECONCILE_INTERVAL_MIN=60 \
    LOG_LEVEL=info \
    node "$ROOT/src/index.ts" > "$WORK/hub.log" 2>&1 &
HPID=$!
sleep 3

BEFORE=$(curl -s "http://127.0.0.1:$HEALTH_PORT/status")
echo "  /status before: $BEFORE"

echo "== inserting an account =="
psql -X -q -d "$DB" -c "INSERT INTO \"user\" (id, email) VALUES ('u7','real@example.com')" >/dev/null
sleep 2
AFTER=$(curl -s "http://127.0.0.1:$HEALTH_PORT/status")
HEALTH_CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$HEALTH_PORT/healthz")
echo "  /status after:  $AFTER"
echo "  /healthz:       $HEALTH_CODE"

kill $HPID 2>/dev/null; kill $MPID 2>/dev/null
wait $HPID 2>/dev/null; wait $MPID 2>/dev/null
psql -X -q -d postgres -c "DROP DATABASE IF EXISTS $DB" >/dev/null 2>&1

echo "--- hub ---"; sed 's/^/  /' "$WORK/hub.log"
echo "--- mock ---"; sed 's/^/  /' "$WORK/mock.log"

assert_contains() { # assert_contains <label> <haystack> <needle>
  case "$2" in *"$3"*) printf '  PASS  %s\n' "$1";; *) printf '  FAIL  %s\n' "$1"; FAIL=$((FAIL+1));; esac
}

echo
assert_contains "hub is healthy" "$HEALTH_CODE" "200"
assert_contains "listening to the trigger channel" "$AFTER" '"listening":true'
assert_contains "notification received" "$AFTER" '"notified":1'

# The startup reconcile may already have added the mock's users, so the
# notification must add exactly one more.
ADDED_BEFORE=$(printf '%s' "$BEFORE" | grep -o '"added":[0-9]*' | head -1 | cut -d: -f2)
ADDED_AFTER=$(printf '%s' "$AFTER" | grep -o '"added":[0-9]*' | head -1 | cut -d: -f2)
if [ "$((ADDED_AFTER))" -eq "$((ADDED_BEFORE + 1))" ]; then
  printf '  PASS  one more account added (%s -> %s)\n' "$ADDED_BEFORE" "$ADDED_AFTER"
else
  printf '  FAIL  expected added=%s, got %s\n' "$((ADDED_BEFORE + 1))" "$ADDED_AFTER"; FAIL=$((FAIL+1))
fi
grep -q "mock: add u7 as member" "$WORK/mock.log" && printf '  PASS  admin API called\n' || { printf '  FAIL  admin API called\n'; FAIL=$((FAIL+1)); }
grep -q "reconcile done" "$WORK/hub.log" && printf '  PASS  reconcile ran\n' || { printf '  FAIL  reconcile ran\n'; FAIL=$((FAIL+1)); }

echo
if [ "$FAIL" -eq 0 ]; then echo "  ALL CHECKS PASSED"; else echo "  $FAIL CHECK(S) FAILED"; fi
[ "$FAIL" -eq 0 ]
