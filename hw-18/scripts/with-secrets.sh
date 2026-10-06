#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ENV_SLUG="${1:-dev}"; shift || true
[ "$#" -gt 0 ] || set -- npm run start

# грейдер не має доступу до сховища: значення вже в оточенні
if [ "${SKIP_VAULT:-0}" = "1" ]; then exec "$@"; fi

CREDS="$ROOT/.secrets/infisical.env"

if [ ! -f "$CREDS" ]; then
  echo "Please either run infisical init to connect to a project or place credentials in .secrets/infisical.env" >&2
  exit 1
fi

if ! command -v infisical >/dev/null 2>&1; then
  echo "infisical CLI is not installed" >&2
  exit 1
fi

exec infisical run --env="$ENV_SLUG" --env-file="$CREDS" -- "$@"
