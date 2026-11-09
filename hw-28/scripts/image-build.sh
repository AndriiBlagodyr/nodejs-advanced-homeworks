#!/usr/bin/env bash
# docker/Dockerfile -> marketplace-api:hw28, with the registry token as a BuildKit secret.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="$(node -p "require('$ROOT/k8s/names.json').image")"
TOKEN_FILE="${NPM_TOKEN_FILE:-$ROOT/.npm_token}"

if [ ! -s "$TOKEN_FILE" ]; then
  echo "missing build secret: $TOKEN_FILE (registry token for npm ci; it is not in git)" >&2
  exit 1
fi

DOCKER_BUILDKIT=1 docker build \
  -f "$ROOT/docker/Dockerfile" \
  --secret "id=npm_token,src=$TOKEN_FILE" \
  -t "$IMAGE" \
  "$ROOT"
