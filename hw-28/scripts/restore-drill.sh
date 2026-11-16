#!/usr/bin/env bash
set -euo pipefail

# Restore-drill: takes the latest backup, restores into a fresh container,
# compares control values from the sidecar checksum, prints MATCH or exits non-zero.

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL: unbound variable" >&2
  exit 1
fi

# Parse DATABASE_URL
REST="${DATABASE_URL#*://}"
USERPASS="${REST%%@*}"
HOSTPORTDB="${REST#*@}"
PG_USER="${USERPASS%%:*}"
PG_PASS="${USERPASS#*:}"
HOSTPORT="${HOSTPORTDB%%/*}"
PG_DB="${HOSTPORTDB#*/}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="$ROOT/backups"

# Find latest dump
LATEST="$(ls -t "$BACKUP_DIR"/*.dump 2>/dev/null | head -1)"
if [ -z "$LATEST" ]; then
  echo "No backup found in $BACKUP_DIR" >&2
  exit 1
fi
echo "Restoring from: $LATEST"

export PGPASSWORD="$PG_PASS"

# Control value from the sidecar written by backup.sh at dump time.
# Falls back to live DB query if sidecar is missing (first-time compat).
CHECKSUM_FILE="${LATEST}.checksum"
if [ -f "$CHECKSUM_FILE" ]; then
  CONTROL_BEFORE=$(cat "$CHECKSUM_FILE")
  echo "Control before (sidecar): $CONTROL_BEFORE"
else
  SRC_HOST="${HOSTPORT%%:*}"
  SRC_PORT="${HOSTPORT#*:}"
  CONTROL_BEFORE=$(psql -h "$SRC_HOST" -p "$SRC_PORT" -U "$PG_USER" -d "$PG_DB" -Atc \
    "SELECT count(*) || '|' || COALESCE(sum(total_cents), 0) FROM orders")
  echo "Control before (live DB): $CONTROL_BEFORE"
fi

# Drill container/volume names (PID-scoped for parallel safety)
DRILL_CONTAINER="marketplace-drill-$$"
DRILL_VOLUME="marketplace_drill_data_$$"

cleanup() {
  echo "Cleaning up drill container and volume..."
  docker rm -f "$DRILL_CONTAINER" >/dev/null 2>&1 || true
  docker volume rm "$DRILL_VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Create fresh volume + Postgres container with a random host port
docker volume create "$DRILL_VOLUME" >/dev/null
docker run -d \
  --name "$DRILL_CONTAINER" \
  -e POSTGRES_USER="$PG_USER" \
  -e POSTGRES_PASSWORD="$PG_PASS" \
  -e POSTGRES_DB="$PG_DB" \
  -v "$DRILL_VOLUME":/var/lib/postgresql/data \
  -p 127.0.0.1:0:5432 \
  postgres:17-alpine >/dev/null

# Read the dynamically assigned port
DRILL_PORT=$(docker port "$DRILL_CONTAINER" 5432 | head -1 | sed 's/.*://')
echo "Drill Postgres on port: $DRILL_PORT"

echo "Waiting for drill Postgres..."
RETRIES=30
until docker exec "$DRILL_CONTAINER" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; do
  RETRIES=$((RETRIES - 1))
  if [ "$RETRIES" -le 0 ]; then
    echo "Drill Postgres did not become ready" >&2
    exit 1
  fi
  sleep 1
done

# Restore
START_TIME=$(date +%s)
pg_restore --no-owner -Fc \
  -h 127.0.0.1 \
  -p "$DRILL_PORT" \
  -U "$PG_USER" \
  -d "$PG_DB" \
  "$LATEST"
END_TIME=$(date +%s)
RESTORE_SECONDS=$((END_TIME - START_TIME))

# Control values AFTER restore
CONTROL_AFTER=$(psql -h 127.0.0.1 -p "$DRILL_PORT" -U "$PG_USER" -d "$PG_DB" -Atc \
  "SELECT count(*) || '|' || COALESCE(sum(total_cents), 0) FROM orders")
echo "Control after:  $CONTROL_AFTER"
echo "Restore time:   ${RESTORE_SECONDS}s"

DUMP_SIZE=$(du -h "$LATEST" | cut -f1)
echo "Dump size:      $DUMP_SIZE"

if [ "$CONTROL_BEFORE" = "$CONTROL_AFTER" ]; then
  echo "MATCH"
else
  echo "MISMATCH: before=$CONTROL_BEFORE after=$CONTROL_AFTER" >&2
  exit 1
fi
