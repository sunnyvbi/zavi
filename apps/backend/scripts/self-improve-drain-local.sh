#!/bin/bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
ENV="apps/backend/.env"
[ -f "$ENV" ] || { echo "missing $ENV"; exit 1; }
SURL=$(grep '^SUPABASE_URL=' "$ENV" | cut -d= -f2-)
SRK=$(grep '^SUPABASE_SERVICE_ROLE_KEY=' "$ENV" | cut -d= -f2-)
[ -n "$SURL" ] && [ -n "$SRK" ] || { echo "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing in $ENV"; exit 1; }

MODE="${1:-list}"

if [ "$MODE" = "--done" ]; then
  ID="${2:-}"; STATUS="${3:-surfaced}"
  [[ "$ID" =~ ^[0-9]+$ ]] || { echo "usage: --done <numeric-id> [surfaced|done|skipped]"; exit 1; }
  case "$STATUS" in surfaced|done|skipped) ;; *) echo "status must be surfaced|done|skipped"; exit 1 ;; esac
  curl -s -X PATCH "$SURL/rest/v1/agent_improvement_requests?id=eq.$ID" \
    -H "apikey: $SRK" -H "Authorization: Bearer $SRK" -H "Content-Type: application/json" -H "Prefer: return=representation" \
    -d "{\"status\":\"$STATUS\"}" \
  | python3 -c "import sys,json
r=json.load(sys.stdin)
print(f'  #{r[0][\"id\"]} {r[0][\"agent_slug\"]} -> {r[0][\"status\"]}') if r else print('  no row with that id')"
  exit 0
fi

if [ "$MODE" != "--run" ]; then
  echo "[drain:list] pending self-improve clusters (read-only):"
  curl -s "$SURL/rest/v1/agent_improvement_requests?status=eq.pending&select=id,agent_slug,digest_reason,window,created_at&order=created_at.asc&limit=100" \
    -H "apikey: $SRK" -H "Authorization: Bearer $SRK" \
  | python3 -c "import sys,json
rows=json.load(sys.stdin)
if not rows: print('  (queue empty — nothing to drain today)'); raise SystemExit
for r in rows: print(f\"  #{r['id']:<5} {r['agent_slug']:<22} {r['digest_reason']:<26} {r['window']}\")
print(f'\n  {len(rows)} pending. RECOMMENDED — run interactively in your Claude Code session:')
for r in rows: print(f\"    /compare-with-claude-super-automation {r['agent_slug']}    # then: --done {r['id']}\")
print('  (--run does it headless but caps each cluster at 30 min; interactive has no cap.)')"
  exit 0
fi

echo "[drain:run] WARNING headless mode caps each cluster at 30 min; for long compares run the skill interactively instead."
command -v claude >/dev/null 2>&1 || { echo "local 'claude' CLI not found — run from your Claude Code env."; exit 1; }
export SUPABASE_URL="$SURL"
export SUPABASE_ANON_KEY="$(grep '^SUPABASE_ANON_KEY=' "$ENV" | cut -d= -f2-)"
export SELF_IMPROVE_READ_TOKEN="$SRK"   # local: service_role authorizes the queue RPCs
TMP=$(mktemp)
GITHUB_OUTPUT="$TMP" node .github/scripts/self-improve-read-clusters.mjs
CLUSTERS=$(grep '^clusters=' "$TMP" | sed 's/^clusters=//' || echo '[]')
COUNT=$(grep '^count=' "$TMP" | sed 's/^count=//' || echo 0)
rm -f "$TMP"
echo "[drain:run] leased $COUNT cluster(s)."
[ "$COUNT" = "0" ] && { echo "Nothing to drain."; exit 0; }
CLUSTERS_JSON="$CLUSTERS" node .github/scripts/self-improve-run.mjs
echo "[drain:run] done. Review PRs (gh pr list), then merge the good ones manually."
