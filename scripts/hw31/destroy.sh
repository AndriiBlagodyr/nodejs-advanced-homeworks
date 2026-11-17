#!/usr/bin/env bash
set -euo pipefail
which="${1:?usage: destroy.sh base|demo}"
# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
ensure_bucket
cd "$ROOT/infra/$which"
if [ ! -d node_modules ]; then
  npm ci --no-audit --no-fund
fi
if ! err="$(pulumi stack select "$which" --non-interactive 2>&1)"; then
  if printf '%s' "$err" | grep -q 'no stack named'; then
    echo "stack $which is already gone"
    exit 0
  fi
  printf '%s\n' "$err" >&2
  exit 1
fi
# A fresh checkout does not contain the email, the bucket name or the db password.
# They were stored in the backend by up. Set them only when this checkout cannot see them,
# so destroy can still evaluate the program.
if ! pulumi config get hw31:stateBucket --non-interactive >/dev/null 2>&1; then
  require HW31_STATE_BUCKET
  pulumi config set hw31:stateBucket "$HW31_STATE_BUCKET" --non-interactive
fi
if [ "$which" = base ] && ! pulumi config get hw31:budgetEmail --non-interactive >/dev/null 2>&1; then
  require HW31_BUDGET_EMAIL
  pulumi config set hw31:budgetEmail "$HW31_BUDGET_EMAIL" --non-interactive
fi
if [ "$which" = demo ] && ! pulumi config get hw31:dbPassword --non-interactive >/dev/null 2>&1; then
  require HW31_DB_PASSWORD
  pulumi config set --secret hw31:dbPassword "$HW31_DB_PASSWORD" --non-interactive
fi
pulumi destroy --yes --non-interactive
mkdir -p "$ROOT/evidence"
pulumi stack export > "$ROOT/evidence/destroyed-${which}-state.json"
