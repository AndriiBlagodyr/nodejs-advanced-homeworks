#!/usr/bin/env bash
# pulumi <cmd> against the local file backend, on stack `dev`.
# Run through scripts/with-secrets.sh: the program reads the vault values from env.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Never fall through to `pulumi login` against a cloud account.
export PULUMI_BACKEND_URL="${PULUMI_BACKEND_URL:-file://$ROOT/.pulumi}"
mkdir -p "${PULUMI_BACKEND_URL#file://}"

cd "$ROOT/infra"
[ -d node_modules ] || npm ci --no-audit --no-fund
pulumi stack select dev --create --non-interactive >/dev/null
exec pulumi "$@"
