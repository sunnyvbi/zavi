#!/bin/sh

set -e
cd /app/apps/backend
if [ -n "$PRAXIS_SECRETS_SECRET_ID" ]; then
  node /app/apps/backend/scripts/docker-load-secrets.cjs
fi
exec "$@"
