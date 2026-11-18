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

# Official tags are a multi-arch index. kind imports with --digests, then
# containerd asks for an attestation blob that `docker save` never packed
# (`content digest … not found`). One platform has no such index.
docker pull --platform linux/amd64 "$PG_IMAGE"

# A host image does not exist inside the node: without this the pod sits in ErrImagePull.
# Load one image per call. A single `kind load` of both images is one import:
# a failure on postgres then leaves the API image out of the node as well.
load_image() {
  local image="$1"
  if kind load docker-image --name "$CLUSTER" "$image"; then
    return 0
  fi
  echo "kind load failed for $image; importing the archive without attestation digests" >&2
  docker save "$image" | docker exec -i "${CLUSTER}-control-plane" ctr --namespace=k8s.io images import -
}
load_image "$IMAGE"
load_image "$PG_IMAGE"
kubectl --context "$(name context)" get nodes -o wide
