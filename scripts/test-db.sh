#!/usr/bin/env bash
# Runs every migration against a throwaway Postgres and then the SQL tests.
# Uses $DATABASE_URL when set (CI service container); otherwise starts a
# temporary local cluster with the Postgres binaries on this machine.
set -euo pipefail
cd "$(dirname "$0")/.."

PSQL_OPTS=(-v ON_ERROR_STOP=1 -q -X)
cleanup() { :; }

if [[ -z "${DATABASE_URL:-}" ]]; then
  PG_BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
  [[ -x "$PG_BIN/initdb" ]] || { echo "Postgres binaries not found; set PG_BIN or DATABASE_URL" >&2; exit 1; }
  TMP="$(mktemp -d)"
  PORT="${PGPORT_TEST:-54329}"
  RUN_AS=()
  if [[ "$(id -u)" == "0" ]]; then
    chown -R nobody "$TMP" 2>/dev/null || true
    RUN_AS=(runuser -u nobody --)
  fi
  "${RUN_AS[@]}" "$PG_BIN/initdb" -D "$TMP/data" -U postgres -A trust >/dev/null
  "${RUN_AS[@]}" "$PG_BIN/pg_ctl" -D "$TMP/data" -o "-p $PORT -k $TMP -c listen_addresses=''" -l "$TMP/log" -w start >/dev/null
  cleanup() { "${RUN_AS[@]}" "$PG_BIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"; }
  trap cleanup EXIT
  DATABASE_URL="postgresql://postgres@/postgres?host=$TMP&port=$PORT"
fi

psql "$DATABASE_URL" "${PSQL_OPTS[@]}" -c "drop database if exists dlos_test" -c "create database dlos_test"
DB_URL="${DATABASE_URL/\/postgres\?//dlos_test?}"
[[ "$DB_URL" == "$DATABASE_URL" ]] && DB_URL="${DATABASE_URL%/*}/dlos_test"

echo "→ shim"
psql "$DB_URL" "${PSQL_OPTS[@]}" -f supabase/tests/supabase_shim.sql
for f in supabase/migrations/*.sql; do
  echo "→ $(basename "$f")"
  psql "$DB_URL" "${PSQL_OPTS[@]}" -f "$f"
done
for f in supabase/tests/[0-9]*.sql; do
  echo "→ test $(basename "$f")"
  psql "$DB_URL" "${PSQL_OPTS[@]}" -o /dev/null -f "$f"
done
echo "✓ database tests passed"
