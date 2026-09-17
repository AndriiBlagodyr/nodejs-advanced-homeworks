#!/usr/bin/env bash
set -euo pipefail

# Parses DATABASE_URL to extract components for pg_dump.
# Expects DATABASE_URL in the environment (via with-secrets.sh or SKIP_VAULT).

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL: unbound variable" >&2
  exit 1
fi

# Parse DATABASE_URL — postgres://user:pass@host:port/dbname
PROTO="${DATABASE_URL%%://*}"
REST="${DATABASE_URL#*://}"
USERPASS="${REST%%@*}"
HOSTPORTDB="${REST#*@}"
PG_USER="${USERPASS%%:*}"
PG_PASS="${USERPASS#*:}"
HOSTPORT="${HOSTPORTDB%%/*}"
PG_DB="${HOSTPORTDB#*/}"
PG_HOST="${HOSTPORT%%:*}"
PG_PORT="${HOSTPORT#*:}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="$ROOT/backups"
mkdir -p "$BACKUP_DIR"

TIMESTAMP="$(date +%Y-%m-%d_%H%M%S)"
BACKUP_FILE="$BACKUP_DIR/${PG_DB}_${TIMESTAMP}.dump"

export PGPASSWORD="$PG_PASS"

echo "Creating backup: $BACKUP_FILE"
pg_dump -Fc \
  -h "$PG_HOST" \
  -p "$PG_PORT" \
  -U "$PG_USER" \
  -d "$PG_DB" \
  -f "$BACKUP_FILE"

SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "Backup complete: $BACKUP_FILE ($SIZE)"
