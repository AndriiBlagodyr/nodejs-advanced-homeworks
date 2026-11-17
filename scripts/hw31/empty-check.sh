#!/usr/bin/env bash
# Six emptiness checks. Each key is printed once: the sum of the stack region and us-east-1.
# The grader keeps the last value of a key, so a second line would hide a leftover.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

REGION="$(awk '/aws:region:/ { print $2; exit }' infra/base/Pulumi.base.yaml)"
if [ -z "$REGION" ]; then
  echo "aws:region is missing from infra/base/Pulumi.base.yaml" >&2
  exit 1
fi

regions=()
add_region() {
  local region existing
  region="$1"
  for existing in "${regions[@]:-}"; do
    if [ "$existing" = "$region" ]; then
      return 0
    fi
  done
  regions+=("$region")
}
add_region "$REGION"
add_region us-east-1

as_int() {
  if [[ ! "$1" =~ ^[0-9]+$ ]]; then
    echo "expected a number, got: $1" >&2
    exit 1
  fi
  echo "$1"
}

tagged_in() {
  local region="$1" token="" total=0 page count pages=0
  while true; do
    pages=$((pages + 1))
    if [ "$pages" -gt 20 ]; then
      echo "tag page did not end in $region" >&2
      exit 1
    fi
    if [ -z "$token" ]; then
      page="$(aws resourcegroupstaggingapi get-resources --region "$region" \
        --tag-filters Key=Project,Values=nodejs-pro-hw31 --output json)"
    else
      page="$(aws resourcegroupstaggingapi get-resources --region "$region" \
        --tag-filters Key=Project,Values=nodejs-pro-hw31 \
        --pagination-token "$token" --output json)"
    fi
    count="$(jq '.ResourceTagMappingList | length' <<<"$page")"
    total=$((total + $(as_int "$count")))
    token="$(jq -r '.PaginationToken // empty' <<<"$page")"
    if [ -z "$token" ]; then
      break
    fi
  done
  echo "$total"
}

state_left=0
for file in evidence/demo-state.json evidence/base-state.json; do
  if [ ! -f "$file" ]; then
    echo "missing $file" >&2
    exit 1
  fi
  n="$(jq '[((.deployment.resources // [])[]) | select(.type | startswith("aws:"))] | length' "$file")"
  state_left=$((state_left + $(as_int "$n")))
done

tagged=0
rds=0
alb=0
nat=0
eip=0
for R in "${regions[@]}"; do
  tagged=$((tagged + $(tagged_in "$R")))
  rds=$((rds + $(as_int "$(aws rds describe-db-instances --region "$R" --query 'length(DBInstances)' --output text)")))
  alb=$((alb + $(as_int "$(aws elbv2 describe-load-balancers --region "$R" --query 'length(LoadBalancers)' --output text)")))
  nat=$((nat + $(as_int "$(aws ec2 describe-nat-gateways --region "$R" --filter Name=state,Values=available --query 'length(NatGateways)' --output text)")))
  eip=$((eip + $(as_int "$(aws ec2 describe-addresses --region "$R" --query 'length(Addresses)' --output text)")))
done

echo "state-resources-left=$state_left"
echo "tagged-resources-left=$tagged"
echo "rds-left=$rds"
echo "alb-left=$alb"
echo "nat-left=$nat"
echo "eip-left=$eip"
