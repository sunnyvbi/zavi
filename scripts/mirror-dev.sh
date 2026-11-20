#!/usr/bin/env bash
set -euo pipefail

PROFILE="${ZAVI_MIRROR_AWS_PROFILE:-zavi-mirror}"
SECRET_ID="${ZAVI_MIRROR_SECRET_ID:-praxis-mirror-dev}"
REGION="${ZAVI_MIRROR_REGION:-us-west-1}"
EXPECTED_REF="${ZAVI_MIRROR_PROJECT_REF:-uwbkkuklvuytqfinbkgm}"
PORTS=(3000 3001 8288)
STATE_DIR="$HOME/.zavi"
PID_FILE="$STATE_DIR/mirror-dev.pids"
LOG_DIR="${TMPDIR:-/tmp}/zavi-mirror-dev"
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"

KEEP_RE='^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|OPENAI_API_KEY|OPENROUTER_API_KEY|FIREWORKS_API_KEY|VOYAGE_API_KEY|TAVILY_API_KEY|APIFY_TOKEN|DATAFORSEO_LOGIN|DATAFORSEO_PASSWORD|ANCHOR_API_KEY|GOOGLE_PAGESPEED_API_KEY|FAL_KEY|CARTESIA_API_KEY|DEEPGRAM_API_KEY|PRAXIS_DAILY_VOICE_BUDGET_MICROS|PRAXIS_VOICE_TURN_WORSTCASE_MICROS|LAUNCH_VIDEO_PUBLIC_LOCAL_UNMETERED|TURNSTILE_SITE_KEY)$'

die() { echo "mirror-dev: $*" >&2; exit 1; }

proc_start() { ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//'; }

down() {
  [ -f "$PID_FILE" ] || { echo "nothing to stop"; return 0; }
  local line pid start
  while IFS='|' read -r pid start; do
    [[ "$pid" =~ ^[0-9]+$ ]] && [ "$pid" -gt 1 ] || continue
    [ "$(proc_start "$pid")" = "$start" ] || continue
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  done < "$PID_FILE"
  sleep 2
  while IFS='|' read -r pid start; do
    [[ "$pid" =~ ^[0-9]+$ ]] && [ "$pid" -gt 1 ] || continue
    [ "$(proc_start "$pid")" = "$start" ] || continue
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  done < "$PID_FILE"
  rm -f "$PID_FILE"
  echo "stopped"
}

env_file_keys() {
  local f
  for f in "$ROOT"/apps/backend/.env "$ROOT"/apps/backend/dev.env "$ROOT"/apps/web/.env "$ROOT"/apps/web/.env.local \
           "$ROOT"/apps/web/.env.development "$ROOT"/apps/web/.env.development.local "$ROOT"/.env "$ROOT"/.env.local; do
    [ -f "$f" ] && sed -n 's/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}\([A-Z][A-Z0-9_]*\)[[:space:]]*=.*/\2/p' "$f"
  done | sort -u
}

env_file_has_value() {
  local f
  for f in "$ROOT"/apps/backend/dev.env "$ROOT"/apps/backend/.env; do
    [ -f "$f" ] && grep -Eq "^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=[[:space:]]*(\"[^\"]+\"|'[^']+'|[^[:space:]#\"'])" "$f" && return 0
  done
  return 1
}

up() {
  [ -n "${ZAVI_MIRROR_SECRET_FILE:-}" ] || command -v aws >/dev/null || die "install the AWS CLI v2 first"
  [ -f "$PID_FILE" ] && die "already running; run 'scripts/mirror-dev.sh down' first"
  local p
  for p in "${PORTS[@]}"; do
    lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1 && die "port $p is busy (not started by this script); free it first"
  done

  local json
  if [ -n "${ZAVI_MIRROR_SECRET_FILE:-}" ]; then
    [ "$(stat -f '%Lp' "$ZAVI_MIRROR_SECRET_FILE")" = "600" ] || die "$ZAVI_MIRROR_SECRET_FILE must be chmod 600"
    json=$(cat "$ZAVI_MIRROR_SECRET_FILE")
  else
    if ! aws sts get-caller-identity --profile "$PROFILE" >/dev/null 2>&1; then
      die "AWS profile $PROFILE does not work (one-time setup: aws configure --profile $PROFILE, with the key from Ravi)"
    fi
    json=$(aws secretsmanager get-secret-value --profile "$PROFILE" --region "$REGION" \
      --secret-id "$SECRET_ID" --query SecretString --output text) || die "could not read $SECRET_ID (ask Ravi for the zavi-mirror-dev access key)"
  fi

  local -a ENVV=("PATH=$PATH" "HOME=$HOME" "USER=${USER:-}" "LOGNAME=${LOGNAME:-}" "TMPDIR=${TMPDIR:-/tmp}" "LANG=${LANG:-en_US.UTF-8}" "TERM=${TERM:-xterm}" "NODE_ENV=development")
  local k
  for k in $(env_file_keys); do
    [[ "$k" =~ $KEEP_RE ]] || ENVV+=("$k=")
  done
  local auth_mode=api_key
  if ! env_file_has_value ANTHROPIC_API_KEY && env_file_has_value CLAUDE_CODE_OAUTH_TOKEN; then auth_mode=subscription; fi
  ENVV+=("PRAXIS_AGENT_AUTH_MODE=$auth_mode")

  local kv supa_url="" anon="" dev_email="" dev_pw="" ok=0
  while IFS= read -r -d '' kv; do
    case "$kv" in
      __MIRROR_OK__) ok=1; continue ;;
      SUPABASE_URL=*) supa_url="${kv#*=}" ;;
      SUPABASE_ANON_KEY=*) anon="${kv#*=}" ;;
      DEV_LOGIN_EMAIL=*) dev_email="${kv#*=}" ;;
      DEV_LOGIN_PASSWORD=*) dev_pw="${kv#*=}" ;;
    esac
    ENVV+=("$kv")
  done < <(printf '%s' "$json" | EXPECTED_REF="$EXPECTED_REF" node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let o;
      try { o = JSON.parse(s); } catch { console.error("the secret is not JSON"); process.exit(3); }
      const want = `https://${process.env.EXPECTED_REF}.supabase.co`;
      if (String(o.SUPABASE_URL || "").trim().replace(/\/$/, "").toLowerCase() !== want) {
        console.error(`SUPABASE_URL in the secret is not the mirror project (${want})`); process.exit(3);
      }
      for (const k of ["SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "DEV_LOGIN_EMAIL", "DEV_LOGIN_PASSWORD"]) {
        if (!o[k]) { console.error(`secret is missing ${k}`); process.exit(3); }
      }
      // Connector app keys. Without them the backend cannot refresh the copied logins,
      // so the connector shows "Connect". Warn, do not stop: the rest of the app works.
      // Each entry lists the env names the backend accepts, in its own fallback order
      // (e.g. Analytics reuses the Google Ads client); any one present is enough.
      const appKeys = {
        "Google Ads": [["GOOGLE_ADS_CLIENT_ID"], ["GOOGLE_ADS_CLIENT_SECRET"], ["GOOGLE_ADS_DEVELOPER_TOKEN"]],
        "Google Analytics": [["GOOGLE_ANALYTICS_CLIENT_ID", "GOOGLE_ADS_CLIENT_ID"], ["GOOGLE_ANALYTICS_CLIENT_SECRET", "GOOGLE_ADS_CLIENT_SECRET"]],
        "Google Search Console": [["GOOGLE_SEARCH_CONSOLE_CLIENT_ID", "GOOGLE_ADS_CLIENT_ID"], ["GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET", "GOOGLE_ADS_CLIENT_SECRET"]],
        "LinkedIn Ads": [["LINKEDIN_ADS_CLIENT_ID", "LINKEDIN_SOCIAL_CLIENT_ID"], ["LINKEDIN_ADS_CLIENT_SECRET", "LINKEDIN_SOCIAL_CLIENT_SECRET"]],
        "LinkedIn": [["LINKEDIN_SOCIAL_CLIENT_ID", "LINKEDIN_CLIENT_ID"], ["LINKEDIN_SOCIAL_CLIENT_SECRET", "LINKEDIN_CLIENT_SECRET"]],
      };
      for (const [name, reqs] of Object.entries(appKeys)) {
        const missing = reqs.filter((alts) => !alts.some((k) => o[k])).map((alts) => alts.join(" or "));
        if (missing.length) console.error(`mirror-dev: warning: ${name} will show as not connected (secret is missing ${missing.join(", ")})`);
      }
      for (const [k, v] of Object.entries(o)) {
        if (!/^[A-Z][A-Z0-9_]*$/.test(k) || /\0/.test(String(v))) continue;
        process.stdout.write(`${k}=${k === "SUPABASE_URL" ? want : v}\0`);
      }
      process.stdout.write("__MIRROR_OK__\0");
    });')
  [ "$ok" = 1 ] && [ -n "$supa_url" ] && [ -n "$anon" ] && [ -n "$dev_email" ] || die "the mirror secret failed validation (see the message above)"
  SUPA_URL="$supa_url" ANON="$anon" DEV_EMAIL="$dev_email" DEV_PW="$dev_pw" node --input-type=module -e '
    import { activeTenantClaim } from "'"$ROOT"'/apps/backend/scripts/mirror/plan.mjs";
    const res = await fetch(`${process.env.SUPA_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: process.env.ANON, "content-type": "application/json" },
      body: JSON.stringify({ email: process.env.DEV_EMAIL, password: process.env.DEV_PW }),
      signal: AbortSignal.timeout(15000),
    }).catch(() => null);
    if (!res?.ok) {
      console.error(`mirror-dev: warning: could not sign in as ${process.env.DEV_EMAIL} to check the mirror matches prod (HTTP ${res?.status ?? "none"})`);
      process.exit(0);
    }
    if (!activeTenantClaim((await res.json()).access_token)) {
      console.error("mirror-dev: WARNING: the mirror does not match prod: its sign-in tokens carry no active_tenant_id, because the custom access token hook is off on the mirror project.");
      console.error("mirror-dev: company switching will fail and tenant data can look empty. Fix: scripts/mirror-upcar.sh migrate with SUPABASE_ACCESS_TOKEN (Ravi), or enable Auth > Hooks > Custom Access Token on the mirror.");
    }
  ' || true
  ENVV+=(
    "NEXT_PUBLIC_SUPABASE_URL=$supa_url" "NEXT_PUBLIC_SUPABASE_ANON_KEY=$anon"
    "PRAXIS_MIRROR=1" "NEXT_PUBLIC_ZAVI_MIRROR=1"
    "PRAXIS_CONTAINER_ROLE=probe"
    "INNGEST_DEV=http://localhost:8288" "INNGEST_SIGNING_KEY=" "INNGEST_EVENT_KEY=" "INNGEST_LOCAL_CRONS="
    "NEXT_PUBLIC_BACKEND_URL=http://localhost:3001" "BACKEND_PUBLIC_URL=http://localhost:3001" "WEB_ORIGIN=http://localhost:3000"
  )

  mkdir -p "$LOG_DIR" "$STATE_DIR"
  : > "$PID_FILE"
  local started_ok=0
  trap '[ "${started_ok:-0}" = 1 ] || { echo "mirror-dev: startup failed, stopping" >&2; down; }' EXIT
  trap 'exit 1' INT TERM

  start_svc() { # dir log cmd...
    local dir="$1" logf="$2"; shift 2
    set -m
    (cd "$dir" && exec env -i "${ENVV[@]}" "$@") >"$logf" 2>&1 &
    local pid=$!
    set +m
    sleep 0.3
    echo "$pid|$(proc_start "$pid")" >> "$PID_FILE"
  }
  start_svc "$ROOT" "$LOG_DIR/inngest.log" npx inngest-cli@latest dev -u http://localhost:3001/api/inngest --no-discovery
  start_svc "$ROOT/apps/backend" "$LOG_DIR/backend.log" npm run dev
  start_svc "$ROOT/apps/web" "$LOG_DIR/web.log" npm run dev

  local b=000 w=000
  for _ in $(seq 1 60); do
    b=$(curl -s -o /dev/null -w '%{http_code}' localhost:3001/health || true)
    w=$(curl -s -o /dev/null -w '%{http_code}' localhost:3000/login || true)
    [ "$b" = 200 ] && [ "$w" = 200 ] && break
    sleep 4
  done
  [ "$b" = 200 ] && [ "$w" = 200 ] || die "not healthy (backend=$b web=$w); logs in $LOG_DIR"
  started_ok=1
  trap - EXIT INT TERM
  echo "backend=$b web=$w (logs: $LOG_DIR)"
  echo "Open http://localhost:3000/login and sign in as $dev_email (password: DEV_LOGIN_PASSWORD in the AWS secret $SECRET_ID)."
  echo "MIRROR: data is a copy, connector actions are REAL. Stop with: scripts/mirror-dev.sh down"
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  *) die "usage: scripts/mirror-dev.sh up | down" ;;
esac
