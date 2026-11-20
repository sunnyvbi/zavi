#!/usr/bin/env bash
set -u
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: .env not found at $ENV_FILE" >&2
  exit 1
fi

SB_URL=$(grep -E "^SUPABASE_URL=" "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
SB_KEY=$(grep -E "^SUPABASE_SERVICE_ROLE_KEY=" "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")

if [ -z "$SB_URL" ] || [ -z "$SB_KEY" ]; then
  echo "ERROR: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing from $ENV_FILE" >&2
  exit 1
fi

echo "[pgrst-reload] hitting $SB_URL/rest/v1/rpc/reload_pgrst_schema ..."
RESPONSE=$(curl -fsSL -X POST "$SB_URL/rest/v1/rpc/reload_pgrst_schema" \
  -H "apikey: $SB_KEY" \
  -H "Authorization: Bearer $SB_KEY" \
  -H "Content-Type: application/json" \
  -d '{}' 2>&1)
RC=$?

if [ $RC -ne 0 ]; then
  echo "[pgrst-reload] FAILED: $RESPONSE" >&2
  echo "" >&2
  echo "If the RPC doesn't exist yet, apply migration 20260518230000_reload_pgrst_schema_helper.sql first:" >&2
  echo "  cd <repo> && supabase db push" >&2
  exit $RC
fi

echo "[pgrst-reload] OK: $RESPONSE"
echo "[pgrst-reload] PostgREST should reload schema within 1-2s. Test with a select on any new column."
