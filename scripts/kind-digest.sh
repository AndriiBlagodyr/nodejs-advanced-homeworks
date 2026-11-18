#!/usr/bin/env bash
# Point the image loaded into kind at the registry digest the pod will name.
# A failure here is not fatal: a public package can still be pulled by the node.
set -euo pipefail

src="$1"
dest="$2"
node="${3:-hw28-control-plane}"

if docker exec "$node" ctr -n k8s.io images tag "$src" "$dest"; then
  echo "kind-image-alias=1"
else
  echo "kind-image-alias=0" >&2
fi
