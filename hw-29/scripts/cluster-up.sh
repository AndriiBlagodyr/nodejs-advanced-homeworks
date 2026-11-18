#!/usr/bin/env bash
# kind create (if missing) + kind load of every image the stack runs.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
name() { node -p "require('$ROOT/k8s/names.json').$1"; }
CLUSTER="$(name cluster)"
IMAGE="$(name image)"
PG_IMAGE="$(name postgresImage)"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "image $IMAGE not found on the host: run npm run image:build first" >&2
  exit 1
fi

if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  echo "cluster $CLUSTER already exists"
else
  kind create cluster --config "$ROOT/k8s/kind-config.yaml" --wait 90s
fi

docker image inspect "$PG_IMAGE" >/dev/null 2>&1 || docker pull "$PG_IMAGE"

# A host image does not exist inside the node: without this the pod sits in ErrImagePull.
# Load one image per call. A single `kind load` of both images is one import:
# a failure on postgres then leaves the API image out of the node as well.
kind load docker-image --name "$CLUSTER" "$IMAGE"
kind load docker-image --name "$CLUSTER" "$PG_IMAGE"
kubectl --context "$(name context)" get nodes -o wide
