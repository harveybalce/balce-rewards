#!/usr/bin/env bash
# Throwaway end-to-end demo. Creates an isolated DB, seeds two mock shops,
# starts the service on a high port, runs the scripted proof, then DROPS
# everything. Nothing persists; nothing touches prod.
set -euo pipefail
cd "$(dirname "$0")"

ENVF=/var/www/aquafinity/backend/.env
export PGHOST=localhost
export PGUSER="$(grep -E '^DB_USER=' "$ENVF" | cut -d= -f2-)"
export PGPASSWORD="$(grep -E '^DB_PASSWORD=' "$ENVF" | cut -d= -f2-)"
export NODE_PATH=/var/www/aquafinity/backend/node_modules
export PORT=5055
DB=balce_rewards_proto

cleanup() {
  [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null || true
  sleep 0.4
  psql -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$DB' AND pid<>pg_backend_pid();" >/dev/null 2>&1 || true
  psql -d postgres -c "DROP DATABASE IF EXISTS $DB;" >/dev/null 2>&1 || true
  rm -f keys.json
}
trap cleanup EXIT

echo "== create throwaway DB: $DB =="
psql -d postgres -c "DROP DATABASE IF EXISTS $DB;" >/dev/null
psql -d postgres -c "CREATE DATABASE $DB;" >/dev/null
export PGDATABASE=$DB

echo "== load schema =="
psql -d "$DB" -f schema.sql >/dev/null

echo "== seed shops + keys =="
node seed.js

echo "== start service on :$PORT =="
node server.js & SRV=$!
for i in $(seq 1 30); do curl -s -o /dev/null "http://localhost:$PORT/health" && break || sleep 0.3; done

echo "==================== DEMO ===================="
node demo.js
echo "=============================================="
# cleanup runs on trap EXIT
