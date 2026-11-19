#!/usr/bin/env bash
# kind create (if missing) + kind load of every image the stack runs.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
name() { node -p "require('$ROOT/k8s/names.json').$1"; }
CLUSTER="$(name cluster)"
IMAGE="${HW32_IMAGE:-$(name image)}"
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

# A host image does not exist inside the node: without this the pod sits in ErrImagePull.
# Load one image per call. A single `kind load` of both images is one import:
# a failure on postgres then leaves the API image out of the node as well.
kind load docker-image --name "$CLUSTER" "$IMAGE"

# The official Postgres tag is a multi-arch index. On the GitHub runner,
# `docker save` omits an attestation blob and both `kind load` and `ctr import`
# fail with `content digest … not found`. The node can pull the public image.
if docker image inspect "$PG_IMAGE" >/dev/null 2>&1 \
  && kind load docker-image --name "$CLUSTER" "$PG_IMAGE"; then
  echo "loaded $PG_IMAGE from the host"
else
  ref="$PG_IMAGE"
  case "$ref" in
    */*) ;;
    *) ref="docker.io/library/$ref" ;;
  esac
  echo "pulling $ref inside the node" >&2
  docker exec "${CLUSTER}-control-plane" crictl pull "$ref"
fi
kubectl --context "$(name context)" get nodes -o wide
