#!/usr/bin/env bash
set -euo pipefail
which="${1:?usage: up.sh base|demo}"
# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
ensure_bucket
use_stack "$which"
if [ "$which" = base ]; then
  require HW31_BUDGET_EMAIL
  pulumi config set hw31:budgetEmail "$HW31_BUDGET_EMAIL" --non-interactive
  pulumi config set hw31:stateBucket "$HW31_STATE_BUCKET" --non-interactive
fi
if [ "$which" = demo ]; then
  require HW31_DB_PASSWORD
  pulumi config set --secret hw31:dbPassword "$HW31_DB_PASSWORD" --non-interactive
  if [ -n "${HW31_WITH_NAT:-}" ]; then
    pulumi config set hw31:withNat "$HW31_WITH_NAT" --non-interactive
  fi
fi
exec pulumi up --yes --non-interactive
