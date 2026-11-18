#!/usr/bin/env bash
# Shared by the HW-31 up/destroy scripts.
# The passphrase is not a credential. CI cannot store one (no GitHub Secrets),
# so local and Actions use the same well-known value. The state bucket is
# private and encrypted with the AWS-managed S3 key. Access is the OIDC role.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# The stack file wins over a stray AWS_REGION or ~/.aws/config.
STACK_REGION="$(awk '/aws:region:/ { print $2; exit }' "$ROOT/infra/base/Pulumi.base.yaml")"
if [ -z "$STACK_REGION" ]; then
  echo "aws:region is missing from infra/base/Pulumi.base.yaml" >&2
  exit 1
fi
export AWS_REGION="$STACK_REGION"
export AWS_DEFAULT_REGION="$STACK_REGION"
export PULUMI_CONFIG_PASSPHRASE="${PULUMI_CONFIG_PASSPHRASE:-hw31-not-a-secret}"

require() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "missing required secret: $name" >&2
    exit 1
  fi
}

ensure_bucket() {
  require HW31_STATE_BUCKET
  export PULUMI_BACKEND_URL="s3://${HW31_STATE_BUCKET}"
  if aws s3api head-bucket --bucket "$HW31_STATE_BUCKET" >/dev/null 2>&1; then
    return 0
  fi
  aws s3api create-bucket \
    --bucket "$HW31_STATE_BUCKET" \
    --region "$AWS_REGION" \
    --create-bucket-configuration "LocationConstraint=${AWS_REGION}"
  aws s3api put-public-access-block \
    --bucket "$HW31_STATE_BUCKET" \
    --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  aws s3api put-bucket-encryption \
    --bucket "$HW31_STATE_BUCKET" \
    --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
  aws s3api put-bucket-versioning \
    --bucket "$HW31_STATE_BUCKET" \
    --versioning-configuration Status=Enabled
}

use_stack() {
  local which="$1"
  cd "$ROOT/infra/$which"
  if [ ! -d node_modules ]; then
    npm ci --no-audit --no-fund
  fi
  pulumi stack select "$which" --create --non-interactive >/dev/null
}
