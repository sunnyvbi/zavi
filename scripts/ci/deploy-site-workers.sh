#!/usr/bin/env bash
set -euo pipefail

ENV_NAME=""
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_NAME="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "::error::unknown argument $1"; exit 2 ;;
  esac
done
case "$ENV_NAME" in prod|dev) ;; *) echo "::error::--env must be prod or dev"; exit 2 ;; esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WRANGLER="${WRANGLER:-npx --no-install wrangler}"
PROD_API_ORIGIN="https://api.zaviagent.com"
PROD_PREVIEW_DOMAIN="preview.zaviagent.com"
PROD_KV_NAMESPACE_ID="7c3e08d420004deb82902f04b4c3b02c"
PROD_R2_BUCKET="zavi-static-sites"
PROD_RL_PREFIX="91"
DEV_RL_PREFIX="92"

REQUIRED=(CLOUDFLARE_ACCOUNT_ID ZAVI_API_ORIGIN SITE_PREVIEW_DOMAIN
  ZAVI_SITE_SIGNER_WORKER_NAME ZAVI_SITE_GATEWAY_WORKER_NAME ZAVI_STATIC_WORKER_NAME
  ZAVI_STATIC_R2_BUCKET ZAVI_STATIC_KV_NAMESPACE_ID
  ZAVI_SITE_GATEWAY_RL_READ_NS ZAVI_SITE_GATEWAY_RL_WRITE_NS ZAVI_SITE_GATEWAY_RL_SITE_NS ZAVI_SITE_GATEWAY_RL_HOOK_NS)
FN_VARS=(ZAVI_FN_DISPATCHER_WORKER_NAME ZAVI_FN_OUTBOUND_WORKER_NAME ZAVI_FN_TAIL_WORKER_NAME ZAVI_FN_NAMESPACE
  ZAVI_FN_DISPATCH_HOST CLOUDFLARE_ZONE_ID ZAVI_FN_RL_SITE_NS ZAVI_FN_RL_EGRESS_NS)

missing=()
for v in "${REQUIRED[@]}"; do [ -n "${!v:-}" ] || missing+=("$v"); done
if [ "$DRY_RUN" = 0 ] && [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then missing+=("CLOUDFLARE_API_TOKEN (secret)"); fi
if [ ${#missing[@]} -gt 0 ]; then
  echo "::error title=Site Workers NOT deployed::missing for --env $ENV_NAME: ${missing[*]}. Set them as GitHub environment variables (the token as an environment secret), or re-run with skip_site_workers=true in an emergency."
  exit 1
fi
export ZAVI_TURNSTILE_SITE_KEY="${ZAVI_TURNSTILE_SITE_KEY:-}"

fn_set=0; fn_missing=()
for v in "${FN_VARS[@]}"; do if [ -n "${!v:-}" ]; then fn_set=$((fn_set + 1)); else fn_missing+=("$v"); fi; done
if [ "$fn_set" -ne 0 ] && [ "$fn_set" -ne ${#FN_VARS[@]} ]; then
  echo "::error title=Site Workers NOT deployed::site functions are half configured for --env $ENV_NAME; missing: ${fn_missing[*]} (set all ${#FN_VARS[@]} or none)."
  exit 1
fi
FUNCTIONS=0; [ "$fn_set" -eq ${#FN_VARS[@]} ] && FUNCTIONS=1

NAME_VARS=(ZAVI_SITE_SIGNER_WORKER_NAME ZAVI_SITE_GATEWAY_WORKER_NAME ZAVI_STATIC_WORKER_NAME)
INT_VARS=(ZAVI_SITE_GATEWAY_RL_READ_NS ZAVI_SITE_GATEWAY_RL_WRITE_NS ZAVI_SITE_GATEWAY_RL_SITE_NS ZAVI_SITE_GATEWAY_RL_HOOK_NS)
if [ "$FUNCTIONS" = 1 ]; then
  NAME_VARS+=(ZAVI_FN_DISPATCHER_WORKER_NAME ZAVI_FN_OUTBOUND_WORKER_NAME ZAVI_FN_TAIL_WORKER_NAME)
  INT_VARS+=(ZAVI_FN_RL_SITE_NS ZAVI_FN_RL_EGRESS_NS)
fi
bad=()
for v in "${NAME_VARS[@]}"; do
  [[ "${!v}" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || bad+=("$v (not a Worker name)")
done
for v in "${INT_VARS[@]}"; do
  [[ "${!v}" =~ ^[0-9]{1,10}$ ]] || bad+=("$v (not an integer)")
done
[[ "$ZAVI_STATIC_KV_NAMESPACE_ID" =~ ^[0-9a-f]{32}$ ]] || bad+=("ZAVI_STATIC_KV_NAMESPACE_ID (not a KV id)")
[[ "$ZAVI_API_ORIGIN" =~ ^https://[a-z0-9.-]+$ ]] || bad+=("ZAVI_API_ORIGIN (must be https://<host>, no path)")
[[ "$SITE_PREVIEW_DOMAIN" =~ ^[a-z0-9.-]+\.[a-z]+$ ]] || bad+=("SITE_PREVIEW_DOMAIN (not a domain)")

if [ "$ENV_NAME" = prod ]; then
  for v in "${NAME_VARS[@]}"; do
    if [[ "${!v}" == *-dev ]]; then bad+=("$v=${!v} ends in -dev on --env prod"); fi
  done
  [ "$ZAVI_API_ORIGIN" = "$PROD_API_ORIGIN" ] || bad+=("ZAVI_API_ORIGIN is not $PROD_API_ORIGIN on --env prod")
  [ "$SITE_PREVIEW_DOMAIN" = "$PROD_PREVIEW_DOMAIN" ] || bad+=("SITE_PREVIEW_DOMAIN is not $PROD_PREVIEW_DOMAIN on --env prod")
  if [ "$FUNCTIONS" = 1 ] && [[ "$ZAVI_FN_NAMESPACE" == *-dev ]]; then bad+=("ZAVI_FN_NAMESPACE ends in -dev on --env prod"); fi
  if [ "$FUNCTIONS" = 1 ] && [[ "${ZAVI_FN_DISPATCH_HOST%%.*}" == *-dev ]]; then bad+=("ZAVI_FN_DISPATCH_HOST is a -dev host on --env prod"); fi
  for v in "${INT_VARS[@]}"; do
    if [[ "${!v}" != "$PROD_RL_PREFIX"* ]]; then bad+=("$v=${!v} is not a prod (${PROD_RL_PREFIX}xxx) rate-limit namespace"); fi
  done
else
  for v in "${NAME_VARS[@]}"; do
    if [[ "${!v}" != *-dev ]]; then bad+=("$v=${!v} does not end in -dev on --env dev"); fi
  done
  [ "$ZAVI_API_ORIGIN" != "$PROD_API_ORIGIN" ] || bad+=("ZAVI_API_ORIGIN is the PROD origin on --env dev")
  [ "$SITE_PREVIEW_DOMAIN" != "$PROD_PREVIEW_DOMAIN" ] || bad+=("SITE_PREVIEW_DOMAIN is the PROD domain on --env dev")
  [ "$ZAVI_STATIC_KV_NAMESPACE_ID" != "$PROD_KV_NAMESPACE_ID" ] || bad+=("ZAVI_STATIC_KV_NAMESPACE_ID is the PROD namespace on --env dev")
  [ "$ZAVI_STATIC_R2_BUCKET" != "$PROD_R2_BUCKET" ] || bad+=("ZAVI_STATIC_R2_BUCKET is the PROD bucket on --env dev")
  if [ "$FUNCTIONS" = 1 ] && [[ "$ZAVI_FN_NAMESPACE" != *-dev ]]; then bad+=("ZAVI_FN_NAMESPACE does not end in -dev on --env dev"); fi
  if [ "$FUNCTIONS" = 1 ] && [[ "${ZAVI_FN_DISPATCH_HOST%%.*}" != *-dev ]]; then bad+=("ZAVI_FN_DISPATCH_HOST=$ZAVI_FN_DISPATCH_HOST: first label must end in -dev on --env dev"); fi
  for v in "${INT_VARS[@]}"; do
    if [[ "${!v}" != "$DEV_RL_PREFIX"* ]]; then bad+=("$v=${!v} is not a dev (${DEV_RL_PREFIX}xxx) rate-limit namespace"); fi
  done
fi
if [ ${#bad[@]} -gt 0 ]; then
  printf '::error title=Site Workers NOT deployed::%s\n' "${bad[@]}"
  exit 1
fi

CI_CONFIGS=("$ROOT/infra/site-gateway/signer/wrangler.ci.toml" "$ROOT/infra/static-host/wrangler.ci.toml"
  "$ROOT/infra/site-gateway/wrangler.ci.toml" "$ROOT/infra/site-functions/wrangler.tail.ci.toml"
  "$ROOT/infra/site-functions/wrangler.outbound.ci.toml" "$ROOT/infra/site-functions/wrangler.dispatcher.ci.toml")
cleanup() { rm -f "${CI_CONFIGS[@]}"; }
trap cleanup EXIT

export ZAVI_TURNSTILE_SITE_KEY CLOUDFLARE_ZONE_ID="${CLOUDFLARE_ZONE_ID:-}" ZAVI_FN_DISPATCH_HOST="${ZAVI_FN_DISPATCH_HOST:-}" \
  ZAVI_FN_DISPATCHER_WORKER_NAME="${ZAVI_FN_DISPATCHER_WORKER_NAME:-}" ZAVI_FN_NAMESPACE="${ZAVI_FN_NAMESPACE:-}" \
  ZAVI_FN_OUTBOUND_WORKER_NAME="${ZAVI_FN_OUTBOUND_WORKER_NAME:-}" ZAVI_FN_RL_EGRESS_NS="${ZAVI_FN_RL_EGRESS_NS:-}" \
  ZAVI_FN_RL_SITE_NS="${ZAVI_FN_RL_SITE_NS:-}" ZAVI_FN_TAIL_WORKER_NAME="${ZAVI_FN_TAIL_WORKER_NAME:-}"
export CLOUDFLARE_ACCOUNT_ID ZAVI_API_ORIGIN SITE_PREVIEW_DOMAIN ZAVI_SITE_SIGNER_WORKER_NAME ZAVI_SITE_GATEWAY_WORKER_NAME \
  ZAVI_STATIC_WORKER_NAME ZAVI_STATIC_R2_BUCKET ZAVI_STATIC_KV_NAMESPACE_ID ZAVI_SITE_GATEWAY_RL_READ_NS \
  ZAVI_SITE_GATEWAY_RL_WRITE_NS ZAVI_SITE_GATEWAY_RL_SITE_NS ZAVI_SITE_GATEWAY_RL_HOOK_NS
SUBST='${CLOUDFLARE_ZONE_ID} ${SITE_PREVIEW_DOMAIN} ${ZAVI_API_ORIGIN} ${ZAVI_FN_DISPATCH_HOST} ${ZAVI_FN_DISPATCHER_WORKER_NAME} ${ZAVI_FN_NAMESPACE} ${ZAVI_FN_OUTBOUND_WORKER_NAME} ${ZAVI_FN_RL_EGRESS_NS} ${ZAVI_FN_RL_SITE_NS} ${ZAVI_FN_TAIL_WORKER_NAME} ${ZAVI_SITE_GATEWAY_RL_HOOK_NS} ${ZAVI_SITE_GATEWAY_RL_READ_NS} ${ZAVI_SITE_GATEWAY_RL_SITE_NS} ${ZAVI_SITE_GATEWAY_RL_WRITE_NS} ${ZAVI_SITE_GATEWAY_WORKER_NAME} ${ZAVI_SITE_SIGNER_WORKER_NAME} ${ZAVI_STATIC_KV_NAMESPACE_ID} ${ZAVI_STATIC_R2_BUCKET} ${ZAVI_STATIC_WORKER_NAME} ${ZAVI_TURNSTILE_SITE_KEY}'

render() {
  local tpl="$1" out
  out="$(dirname "$tpl")/$(basename "$tpl" .toml).ci.toml"
  envsubst "$SUBST" < "$tpl" > "$out"
  if grep -nE '^[^#]*\$\{' "$out" >&2; then echo "::error::unrendered variables left in $out (above)" >&2; return 1; fi
  printf '%s' "$out"
}

SIGNER_CFG=$(render "$ROOT/infra/site-gateway/signer/wrangler.toml")
STATIC_CFG=$(render "$ROOT/infra/static-host/wrangler.toml")
GATEWAY_CFG=$(render "$ROOT/infra/site-gateway/wrangler.toml")
if [ "$FUNCTIONS" = 1 ]; then
  TAIL_CFG=$(render "$ROOT/infra/site-functions/wrangler.tail.toml")
  OUTBOUND_CFG=$(render "$ROOT/infra/site-functions/wrangler.outbound.toml")
  DISPATCHER_CFG=$(render "$ROOT/infra/site-functions/wrangler.dispatcher.toml")
else
  python3 - "$GATEWAY_CFG" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p).read()
s2, n = re.subn(r'\[\[services\]\]\nbinding = "FUNCTIONS"\nservice = "[^"\n]*"\n', '', s)
if n != 1:
    sys.exit("expected exactly one FUNCTIONS service block in the gateway config, found %d" % n)
open(p, "w").write(s2)
PY
  if grep -q 'binding = "FUNCTIONS"' "$GATEWAY_CFG"; then echo "::error::FUNCTIONS binding still in the gateway config"; exit 1; fi
  echo "::notice title=Site functions skipped::site-functions variables are unset for --env $ENV_NAME: not deployed; gateway FUNCTIONS binding stripped (/api/fn answers 503)."
fi

deploy() {
  local label="$1" cfg="$2"
  echo "::group::deploy $label"
  if [ "$DRY_RUN" = 1 ]; then
    (cd "$(dirname "$cfg")" && $WRANGLER deploy -c "$(basename "$cfg")" --dry-run --outdir "${RUNNER_TEMP:-/tmp}/site-workers-dry/$label") \
      || { echo "::error title=Site Worker build failed::$label"; exit 1; }
  else
    (cd "$(dirname "$cfg")" && $WRANGLER deploy -c "$(basename "$cfg")") \
      || { echo "::error title=Site Worker deploy failed::$label ($cfg). Workers deployed before it in this run stay live; the backend is NOT deployed. Re-run, or use skip_site_workers=true in an emergency."; exit 1; }
  fi
  echo "::endgroup::"
}

deploy signer "$SIGNER_CFG"
deploy static-host "$STATIC_CFG"
if [ "$FUNCTIONS" = 1 ]; then
  gw_probe=""
  if [ "$DRY_RUN" = 0 ] && ! gw_probe=$(cd "$(dirname "$GATEWAY_CFG")" && $WRANGLER deployments list -c "$(basename "$GATEWAY_CFG")" 2>&1); then
    if ! printf '%s' "$gw_probe" | grep -qiE '10007|script_not_found|does not exist|not found'; then
      printf '%s\n' "$gw_probe" | tail -5
      echo "::error title=Site Workers NOT deployed::could not read the gateway's deployments (not a 'Worker missing' answer); refusing to guess whether it exists."
      exit 1
    fi
    BOOT_CFG="$(dirname "$GATEWAY_CFG")/wrangler.bootstrap.ci.toml"
    CI_CONFIGS+=("$BOOT_CFG")
    python3 - "$GATEWAY_CFG" "$BOOT_CFG" <<'PY'
import re, sys
s = open(sys.argv[1]).read()
s2, n = re.subn(r'\[\[services\]\]\nbinding = "FUNCTIONS"\nservice = "[^"\n]*"\n', '', s)
if n != 1:
    sys.exit("expected exactly one FUNCTIONS service block in the gateway config, found %d" % n)
open(sys.argv[2], "w").write(s2)
PY
    echo "::notice title=Gateway bootstrap::$ZAVI_SITE_GATEWAY_WORKER_NAME does not exist yet: deploying it once without FUNCTIONS so the outbound Worker can bind it."
    deploy gateway-bootstrap "$BOOT_CFG"
  fi
  deploy fn-tail "$TAIL_CFG"
  deploy fn-outbound "$OUTBOUND_CFG"
  deploy fn-dispatcher "$DISPATCHER_CFG"
fi
deploy gateway "$GATEWAY_CFG"

if [ "$DRY_RUN" = 1 ]; then echo "dry run: every Worker built; nothing deployed"; exit 0; fi

smoke_fail=0
SMOKE=("signer:$SIGNER_CFG" "static-host:$STATIC_CFG" "gateway:$GATEWAY_CFG")
if [ "$FUNCTIONS" = 1 ]; then SMOKE+=("fn-tail:$TAIL_CFG" "fn-outbound:$OUTBOUND_CFG" "fn-dispatcher:$DISPATCHER_CFG"); fi
for pair in "${SMOKE[@]}"; do
  label="${pair%%:*}"; cfg="${pair#*:}"
  echo "== $label: latest deployments"
  if out=$(cd "$(dirname "$cfg")" && $WRANGLER deployments list -c "$(basename "$cfg")" 2>&1); then
    printf '%s\n' "$out" | tail -15
  else
    printf '%s\n' "$out" | tail -5
    echo "::error::wrangler deployments list failed for $label"; smoke_fail=1
  fi
done

label=$(LC_ALL=C tr -dc 'a-z2-7' < /dev/urandom | head -c 26 || true)
for path in / /api/site; do
  url="https://${label}.${SITE_PREVIEW_DOMAIN}${path}"
  if [ "$path" = / ]; then marker="preview does not exist"; else marker="site_not_found"; fi
  hdr=$(mktemp); body=$(mktemp)
  code=$(curl -sS --max-time 15 -o "$body" -D "$hdr" -w '%{http_code}' "$url" 2>/dev/null || true)
  [[ "$code" =~ ^[1-9][0-9][0-9]$ ]] || code=000
  server=$(grep -i '^server:' "$hdr" | tr -d '\r' | head -1 | cut -d' ' -f2- | tr 'A-Z' 'a-z' || true)
  cloudfront=0; if grep -qiE '^(x-amz-cf-id|via:.*cloudfront)' "$hdr"; then cloudfront=1; fi
  if [[ "$code" =~ ^(403|404|410)$ ]] && [ "$server" = cloudflare ] && [ "$cloudfront" = 0 ] && grep -q "$marker" "$body"; then
    echo "preview smoke OK: $path -> $code from our Worker ($marker)"
  elif [ "$server" = cloudflare ] && grep -qiE 'worker threw exception|error code: 110[0-9]|Error 110[0-9]' "$body"; then
    echo "::error title=Preview smoke failed::$path: a site Worker threw (http $code) right after this deploy"; smoke_fail=1
  else
    echo "::warning title=Preview smoke not conclusive::$path on ${SITE_PREVIEW_DOMAIN}: http=$code server=${server:-none} cloudfront=$cloudfront, no Worker answer. The preview wildcard route/DNS is not set up yet (the backend creates it); this does not prove the Workers are broken."
  fi
  rm -f "$hdr" "$body"
done

[ "$smoke_fail" = 0 ] || exit 1
echo "site Workers deployed for --env $ENV_NAME"
