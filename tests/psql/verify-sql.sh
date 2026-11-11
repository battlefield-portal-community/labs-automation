#!/bin/sh
# Applies sql/001-auto-join-notify.sql to a throwaway database and checks it.
#
#   docker run --rm -d --name kaneo-pgtest -e POSTGRES_USER=kaneo \
#     -e POSTGRES_PASSWORD=test -e POSTGRES_DB=kaneo -p 127.0.0.1:55432:5432 postgres:16-alpine
#   PGPASSWORD=test PGHOST=127.0.0.1 PGPORT=55432 PGUSER=kaneo sh tests/psql/verify-sql.sh
set -u

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DB=kaneo_labs_sql
PSQL="psql -X -q -v ON_ERROR_STOP=1"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/labs-sql.XXXXXX") || exit 1
PASS=0
FAIL=0
trap 'rm -rf "$WORK"' EXIT INT TERM

check() {
  if [ "$2" = "$3" ]; then printf '  PASS  %s (%s)\n' "$1" "$3"; PASS=$((PASS+1));
  else printf '  FAIL  %s (expected %s, got %s)\n' "$1" "$2" "$3"; FAIL=$((FAIL+1)); fi
}
contains() {
  if grep -q "$2" "$3" 2>/dev/null; then printf '  PASS  %s\n' "$1"; PASS=$((PASS+1));
  else printf '  FAIL  %s (no "%s")\n' "$1" "$2"; FAIL=$((FAIL+1)); fi
}

echo "postgres: $(psql -X -tAc 'select version()' -d postgres | cut -c1-40)"

$PSQL -d postgres -c "DROP DATABASE IF EXISTS $DB" >/dev/null 2>&1
$PSQL -d postgres -c "CREATE DATABASE $DB" >/dev/null || exit 1
$PSQL -d "$DB" -c 'CREATE TABLE "user" (id text PRIMARY KEY, email text NOT NULL,
  is_anonymous boolean DEFAULT false, banned boolean DEFAULT false, role text,
  created_at timestamptz NOT NULL DEFAULT now());' >/dev/null

echo
echo "== 1. the file applies =="
$PSQL -d "$DB" -f "$ROOT/sql/001-auto-join-notify.sql" > "$WORK/apply.log" 2>&1
check "apply exit code" 0 $?
check "trigger present" 1 "$($PSQL -d "$DB" -tAc "select count(*) from pg_trigger where tgname = 'kaneo_notify_new_user'")"
check "function present" 1 "$($PSQL -d "$DB" -tAc "select count(*) from pg_proc where proname = 'kaneo_notify_new_user'")"

cat > "$WORK/listen.sql" <<'SQL'
LISTEN kaneo_new_user;
SELECT pg_sleep(0.2);
SELECT pg_sleep(0.2);
SELECT pg_sleep(0.2);
SELECT pg_sleep(0.2);
SELECT pg_sleep(0.2);
SELECT pg_sleep(0.2);
SELECT pg_sleep(0.2);
SELECT pg_sleep(0.2);
SQL

echo
echo "== 2. a new account notifies with id + email =="
( $PSQL -d "$DB" -f "$WORK/listen.sql" > "$WORK/listen.log" 2>&1 ) &
LPID=$!
sleep 0.8
$PSQL -d "$DB" -c "INSERT INTO \"user\" (id, email) VALUES ('u1','a@example.com')" >/dev/null
wait $LPID
contains "notification on kaneo_new_user" "kaneo_new_user" "$WORK/listen.log"
contains "payload carries the id" '"id" : "u1"' "$WORK/listen.log"
contains "payload carries the email" "a@example.com" "$WORK/listen.log"

echo
echo "== 3. guest accounts stay silent =="
( $PSQL -d "$DB" -f "$WORK/listen.sql" > "$WORK/guest.log" 2>&1 ) &
LPID=$!
sleep 0.8
$PSQL -d "$DB" -c "INSERT INTO \"user\" (id, email, is_anonymous) VALUES ('g1','guest@kaneo.app', true)" >/dev/null
wait $LPID
if grep -q "kaneo_new_user" "$WORK/guest.log"; then
  printf '  FAIL  guest must not notify\n'; FAIL=$((FAIL+1))
else
  printf '  PASS  guest did not notify\n'; PASS=$((PASS+1))
fi

echo
echo "== 4. schema drift cannot break sign-ups =="
$PSQL -d "$DB" -c 'ALTER TABLE "user" RENAME COLUMN email TO email_addr' >/dev/null
check "insert still succeeds" 0 "$($PSQL -d "$DB" -c "INSERT INTO \"user\" (id, email_addr) VALUES ('u2','b@example.com')" >/dev/null 2>&1; echo $?)"
$PSQL -d "$DB" -c "INSERT INTO \"user\" (id, email_addr) VALUES ('u3','c@example.com')" > "$WORK/drift.log" 2>&1
contains "warning instead of error" "kaneo_notify_new_user skipped" "$WORK/drift.log"
$PSQL -d "$DB" -c 'ALTER TABLE "user" RENAME COLUMN email_addr TO email' >/dev/null

echo
echo "== 5. the file is re-runnable =="
check "second apply exit code" 0 "$($PSQL -d "$DB" -f "$ROOT/sql/001-auto-join-notify.sql" >/dev/null 2>&1; echo $?)"
check "still exactly one trigger" 1 "$($PSQL -d "$DB" -tAc "select count(*) from pg_trigger where tgname = 'kaneo_notify_new_user'")"

$PSQL -d postgres -c "DROP DATABASE IF EXISTS $DB" >/dev/null 2>&1

echo
echo "=============================================="
printf '  PASS: %s   FAIL: %s\n' "$PASS" "$FAIL"
echo "=============================================="
[ "$FAIL" -eq 0 ]
