#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SECRET_FILE="${ROOT_DIR}/secrets/db_password"
NEW_PASSWORD="$(openssl rand -hex 24)"
COMPOSE=(docker compose --project-directory "${ROOT_DIR}")

if [[ ! -f "${SECRET_FILE}" ]]; then
  echo "Secret file not found: ${SECRET_FILE}" >&2
  exit 1
fi

run_psql() {
  "${COMPOSE[@]}" exec -T postgres \
    psql --username app --dbname marketplace --set ON_ERROR_STOP=1 "$@"
}

# The order matters: update PostgreSQL, refresh the mounted file, then force
# the pool to establish new connections with the reread password.
run_psql --command "ALTER ROLE app WITH PASSWORD '${NEW_PASSWORD}';"

umask 077
printf '%s\n' "${NEW_PASSWORD}" > "${SECRET_FILE}"

run_psql --command "
  SELECT pg_terminate_backend(pid)
  FROM pg_stat_activity
  WHERE usename = 'app'
    AND pid <> pg_backend_pid();
"

echo "Database password rotated; the API process was not restarted."
