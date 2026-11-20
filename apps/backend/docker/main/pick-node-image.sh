#!/usr/bin/env bash
set -uo pipefail
TAG="${NODE_IMAGE_TAG:-22-slim}"
CANDIDATES=(
  "public.ecr.aws/docker/library/node:${TAG}"
  "mirror.gcr.io/library/node:${TAG}"
  "docker.io/library/node:${TAG}"
)
for attempt in 1 2; do
  for ref in "${CANDIDATES[@]}"; do
    if docker pull -q "$ref" >&2; then
      echo "$ref"
      exit 0
    fi
    echo "pick-node-image: $ref failed (attempt $attempt)" >&2
  done
  sleep 15
done
echo "pick-node-image: no registry served node:${TAG}" >&2
exit 1
