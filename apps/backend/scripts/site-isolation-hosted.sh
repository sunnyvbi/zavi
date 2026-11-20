#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "${ZSI_HOSTED_ENV:-}" != "staging" ]; then
  echo "refused: set ZSI_HOSTED_ENV=staging (this gate never runs against production)" >&2
  exit 2
fi
missing=()
for p in ZSI_POOLED_ ZSI_KERNEL_; do
  for k in REF PUBLISHABLE_KEY SERVICE_KEY DB_URL BROKER_DB_URL HOOK_SECRET SIGNER_JWK; do
    name="$p$k"
    [ -n "${!name:-}" ] || missing+=("$name")
  done
done
[ -n "${ZSI_HOSTED_CONFIRM:-}" ] || missing+=("ZSI_HOSTED_CONFIRM")
if [ "${#missing[@]}" -gt 0 ]; then
  echo "refused: missing ${missing[*]}" >&2
  exit 2
fi

ZSI=1 ZSI_TARGET=hosted exec npx vitest run src/services/site-shards/__tests__/isolation/cross-site-isolation.e2e.test.ts
