#!/usr/bin/env bash
set -euo pipefail
file="${1:?usage: nginx-enable-http2.sh <site-file>}"
[ -f "$file" ] || { echo "no such file: $file" >&2; exit 2; }
grep -Eq '^[[:space:]]*listen[[:space:]]+(\[::\]:)?443[[:space:]]+ssl' "$file" || { echo "no TLS listener in $file" >&2; exit 3; }
if ! grep -E '^[[:space:]]*listen[[:space:]]+(\[::\]:)?443[[:space:]]+ssl' "$file" | grep -qv 'http2'; then
  exit 3
fi
tmp="$(mktemp)"
sed -E '/^[[:space:]]*listen[[:space:]]+(\[::\]:)?443[[:space:]]+ssl/{/http2/!s/(443[[:space:]]+ssl)([[:space:];])/\1 http2\2/;}' "$file" > "$tmp"
cat "$tmp" > "$file"
rm -f "$tmp"
