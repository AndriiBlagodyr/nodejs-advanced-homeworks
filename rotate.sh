#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SECRET_FILE="${DB_PASSWORD_FILE:-${ROOT_DIR}/secrets/db_password}"
NEW_PASSWORD="$(openssl rand -hex 24)"
COMPOSE=(docker compose --project-directory "${ROOT_DIR}")
DATABASE_CHANGED=false
SECRET_UPDATED=false

if [[ ! -f "${SECRET_FILE}" ]]; then
  echo "Secret file not found: ${SECRET_FILE}" >&2
  exit 1
fi

OLD_PASSWORD="$(< "${SECRET_FILE}")"

run_psql() {
  "${COMPOSE[@]}" exec -T postgres \
    psql --username app --dbname marketplace --set ON_ERROR_STOP=1 "$@"
}

set_database_password() {
  local password="$1"

  run_psql --set "role_password=${password}" <<'SQL'
ALTER ROLE app WITH PASSWORD :'role_password';
SQL
}

rollback_if_secret_update_failed() {
  local exit_code=$?

  if [[ "${exit_code}" -ne 0 &&
        "${DATABASE_CHANGED}" == true &&
        "${SECRET_UPDATED}" == false ]]; then
    echo "Secret update failed; restoring the previous database password." >&2

    if ! set_database_password "${OLD_PASSWORD}"; then
      echo "CRITICAL: database password rollback failed." >&2
    fi
  fi

  exit "${exit_code}"
}

trap rollback_if_secret_update_failed EXIT

# The order matters: update PostgreSQL, refresh the mounted file, then force
# the pool to establish new connections with the reread password.
set_database_password "${NEW_PASSWORD}"
DATABASE_CHANGED=true

umask 077
printf '%s\n' "${NEW_PASSWORD}" > "${SECRET_FILE}"
SECRET_UPDATED=true

run_psql --command "
  SELECT pg_terminate_backend(pid)
  FROM pg_stat_activity
  WHERE usename = 'app'
    AND pid <> pg_backend_pid();
"

trap - EXIT
echo "Database password rotated; the API process was not restarted."
