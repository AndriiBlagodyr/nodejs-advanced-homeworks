#!/usr/bin/env bash
set -euo pipefail

# Parses DATABASE_URL to extract components for pg_dump.
# Expects DATABASE_URL in the environment (via with-secrets.sh or SKIP_VAULT).

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL: unbound variable" >&2
  exit 1
fi

# Parse DATABASE_URL — postgres://user:pass@host:port/dbname
REST="${DATABASE_URL#*://}"
USERPASS="${REST%%@*}"
HOSTPORTDB="${REST#*@}"
PG_USER="${USERPASS%%:*}"
PG_PASS="${USERPASS#*:}"
HOSTPORT="${HOSTPORTDB%%/*}"
PG_DB="${HOSTPORTDB#*/}"
PG_HOST="${HOSTPORT%%:*}"
PG_PORT="${HOSTPORT#*:}"

# Bypass PgBouncer — connect to Postgres directly.
# DATABASE_URL points at PgBouncer (5432); Postgres listens on DIRECT_PG_PORT.
DIRECT_PG_PORT="${DIRECT_PG_PORT:-5433}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="$ROOT/backups"
mkdir -p "$BACKUP_DIR"

TIMESTAMP="$(date +%Y-%m-%d_%H%M%S)"
BACKUP_FILE="$BACKUP_DIR/${PG_DB}_${TIMESTAMP}.dump"

export PGPASSWORD="$PG_PASS"

echo "Creating backup: $BACKUP_FILE"
pg_dump -Fc \
  -h "$PG_HOST" \
  -p "$DIRECT_PG_PORT" \
  -U "$PG_USER" \
  -d "$PG_DB" \
  -f "$BACKUP_FILE"

# Save control checksum as sidecar for the restore-drill
CONTROL=$(psql -h "$PG_HOST" -p "$DIRECT_PG_PORT" -U "$PG_USER" -d "$PG_DB" -Atc \
  "SELECT count(*) || '|' || COALESCE(sum(total_cents), 0) FROM orders")
echo "$CONTROL" > "${BACKUP_FILE}.checksum"

# Rotate: keep only the 7 most recent dumps (+ their sidecars)
cd "$BACKUP_DIR"
ls -t *.dump 2>/dev/null | tail -n +8 | while read -r OLD; do
  rm -f "$OLD" "${OLD}.checksum"
done

SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "Backup complete: $BACKUP_FILE ($SIZE)"
