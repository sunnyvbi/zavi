#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PASS=0
FAIL=0
NOTE() { echo "[smoke] $1"; }
ASSERT() {
  local name="$1"
  local cond="$2"
  if eval "$cond"; then
    PASS=$((PASS + 1))
    echo "  ✓ $name"
  else
    FAIL=$((FAIL + 1))
    echo "  ✗ $name"
  fi
}

NOTE "1. Backend health"
HTTP=$(/usr/bin/curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/health || echo "000")
ASSERT "GET /health → 200" "[ '$HTTP' = '200' ]"

NOTE "2. /api/agents requires Bearer"
HTTP=$(/usr/bin/curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/api/agents)
ASSERT "GET /api/agents (no token) → 401" "[ '$HTTP' = '401' ]"

NOTE "3. /api/agents/<slug>/run requires Bearer"
HTTP=$(/usr/bin/curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3001/api/agents/chief-of-staff/run \
  -H 'Content-Type: application/json' -d '{}')
ASSERT "POST /api/agents/chief-of-staff/run (no token) → 401" "[ '$HTTP' = '401' ]"

NOTE "4. /api/connectors requires Bearer"
HTTP=$(/usr/bin/curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/api/connectors)
ASSERT "GET /api/connectors (no token) → 401" "[ '$HTTP' = '401' ]"

NOTE "5. /api/onboarding/activate requires Bearer"
HTTP=$(/usr/bin/curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3001/api/onboarding/activate \
  -H 'Content-Type: application/json' \
  -d '{"slug":"smoke","memory":{"company":"x","ops":"x","policies":"x","disputes":"x","support":"x"}}')
ASSERT "POST /api/onboarding/activate (no token) → 401" "[ '$HTTP' = '401' ]"

NOTE "6. Bogus Bearer is rejected"
HTTP=$(/usr/bin/curl -s -o /dev/null -w "%{http_code}" \
  -H 'Authorization: Bearer not-a-real-token' \
  http://localhost:3001/api/agents)
ASSERT "Bogus Bearer → 401" "[ '$HTTP' = '401' ]"

NOTE "7. Unknown route still 404"
HTTP=$(/usr/bin/curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/api/does-not-exist)
ASSERT "GET /api/does-not-exist → 404" "[ '$HTTP' = '404' ]"

echo ""
echo "─────────────────────────────────────────"
echo "  $PASS passed · $FAIL failed"
echo "─────────────────────────────────────────"
echo ""
echo "Full integration smoke (real Bearer JWT, RLS isolation, RPC round-trips)"
echo "lives in `npm run test:rls`. Phase D adds the async-runtime smoke."

[ "$FAIL" -eq 0 ]
