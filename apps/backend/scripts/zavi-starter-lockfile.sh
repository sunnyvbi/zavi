#!/usr/bin/env bash
set -euo pipefail
NODE="${NODE:-node}"
"$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=6)?0:1)' \
  || { echo "need Node >= 22.6 (got $("$NODE" --version)); set NODE=..." >&2; exit 1; }

NPM_PIN="10.9.4"
if [ "$(npm --version)" != "$NPM_PIN" ] && [ "${ZAVI_LOCK_NPM_ANY:-}" != "1" ]; then
  echo "npm $(npm --version) != pinned $NPM_PIN (set ZAVI_LOCK_NPM_ANY=1 to override)" >&2; exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"   # apps/backend
TPL="$ROOT/src/services/provisioning/templates"
ZAVI="$TPL/vite-react-zavi"
SEED="$TPL/vite-react-supabase/files/package-lock.json"
REG="https://registry.npmjs.org/"

if command -v memory_pressure >/dev/null; then
  free=$(memory_pressure | tail -1 | grep -o '[0-9]\+' | tail -1)
  if [ "${free:-0}" -lt 30 ]; then echo "memory free ${free}% < 30%: wait and retry" >&2; exit 1; fi
fi
if pgrep -f "npm (install|ci)" >/dev/null; then echo "another npm install is running: wait and retry" >&2; exit 1; fi

TMP="$(mktemp -d -t zavi-starter-lock)"
trap 'rm -rf "$TMP"' EXIT
cp -R "$ZAVI/files/." "$TMP/"
cp "$SEED" "$TMP/package-lock.json"
cd "$TMP"
npm install --package-lock-only --ignore-scripts --no-audit --no-fund --registry="$REG"
cp package-lock.json lock.resolved
npm ci --ignore-scripts --no-audit --no-fund --registry="$REG" --cache "$TMP/.npm-cache"
npm run check
npm run typecheck
npm run build
cmp -s package-lock.json lock.resolved || { echo "npm ci changed the lock: not reproducible" >&2; exit 1; }
if grep -o '"resolved": "[^"]*"' package-lock.json | grep -v "\"$REG" >/dev/null; then
  echo "a package resolves outside $REG" >&2; exit 1
fi

cp package-lock.json "$ZAVI/files/package-lock.json"
GEN="$ZAVI/_gen.$$.mts"
trap 'rm -rf "$TMP" "$GEN"' EXIT
sed -e 's/const HERE = __dirname;/const HERE = import.meta.dirname;/' \
    -e 's/if (require.main === module) {/if (true) {/' \
    "$ZAVI/generate-template-files.ts" > "$GEN"
"$NODE" --experimental-strip-types --no-warnings "$GEN"
echo "OK: wrote $ZAVI/files/package-lock.json and regenerated template-files.generated.ts"
