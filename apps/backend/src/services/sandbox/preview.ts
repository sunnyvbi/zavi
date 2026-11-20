
import { execCommand, getSandboxHost } from "./e2b-client";

export const PREVIEW_BOOT_TIMEOUT_DEFAULT_S = 90;
export const PREVIEW_DEFAULT_PORT = 3000;
export const PREVIEW_CANDIDATE_PORTS = [3000, 3001, 5173, 4321, 8080, 4000, 5000];
export const PREVIEW_EXEC_HEADROOM_S = 15;

export type StartPreviewResult = {
  url: string;
  port: number;
};

export class PreviewBootError extends Error {
  readonly deadReason: string;
  constructor(message: string, deadReason: string) {
    super(message);
    this.name = "PreviewBootError";
    this.deadReason = deadReason;
  }
}

export function previewEnabled(): boolean {
  return process.env.INSTANT_PREVIEW_ENABLED !== "0";
}

function shq(v: string): string {
  return `'${v.replace(/'/g, "'\\''")}'`;
}

export const PREVIEW_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  "NODE_OPTIONS",
  "NODE_ENV",
  "PORT",
  "HOST",
  "HOSTNAME",
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TZ",
  "CI",
  "TERM",
  "NEXT_TELEMETRY_DISABLED",
]);

export function isPublicBuildVar(key: string): boolean {
  return /^(NEXT_PUBLIC_|VITE_|REACT_APP_|PUBLIC_|EXPO_PUBLIC_)/.test(key);
}

export function isSecretShapedEnvKey(key: string): boolean {
  if (isPublicBuildVar(key)) return false;
  return /(SECRET|_KEY$|_KEY_|APIKEY|TOKEN|PASSWORD|PASSWD|OPERATOR_DB|STRIPE|_DSN$|CREDENTIAL|PRIVATE_)/i.test(
    key,
  );
}

export const PREVIEW_SANITIZE_SECRET_KEYS = [
  "GITHUB_TOKEN",
  "SLACK_BOT_TOKEN",
  "STRIPE_SECRET_KEY",
  "OPERATOR_DB_URL",
] as const;

export const PREVIEW_SECRET_DUMMY = "zavi-preview-sanitized-disabled";

const SECRET_DUMMY_BY_KEY: Record<string, string> = {
  STRIPE_SECRET_KEY: "sk_test_zaviPreviewSanitizedDisabled00000000",
  OPERATOR_DB_URL: "postgres://preview:disabled@127.0.0.1:1/preview_disabled",
  SLACK_BOT_TOKEN: "xoxb-zavi-preview-sanitized-disabled",
  GITHUB_TOKEN: PREVIEW_SECRET_DUMMY,
};

export function previewSecretDummy(key: string): string {
  return SECRET_DUMMY_BY_KEY[key] ?? PREVIEW_SECRET_DUMMY;
}

export function buildSanitizedPreviewEnv(
  raw: Record<string, unknown> | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (typeof v !== "string") continue;
    if (PREVIEW_ENV_ALLOWLIST.has(k) || isPublicBuildVar(k)) {
      out[k] = v;
    } else if (isSecretShapedEnvKey(k)) {
      out[k] = previewSecretDummy(k);
    }
  }
  return out;
}

export function sanitizeSecretEnvBashLines(
  keys: readonly string[] = PREVIEW_SANITIZE_SECRET_KEYS,
): string {
  return keys.map((k) => `export ${k}=${shq(previewSecretDummy(k))}`).join("\n");
}

export function parseExplicitPort(cmd: string): number | null {
  const m = cmd.match(/(?:--port[= ]|(?:^|\s)-p\s+|(?:^|\s)PORT=)(\d{2,5})/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

export function buildPreviewBootScript(opts: {
  port?: number;
  boot_timeout_seconds?: number;
  repo_dir?: string;
  start_cmd?: string;
  allow_npm_install?: boolean;
  shared_root?: string;
  install_timeout_s?: number;
  sanitize_secret_env?: boolean;
}): string {
  const port = opts.port ?? PREVIEW_DEFAULT_PORT;
  const bootTimeout = opts.boot_timeout_seconds ?? PREVIEW_BOOT_TIMEOUT_DEFAULT_S;
  const repoDir = opts.repo_dir ?? "/home/user/repo";

  const candidateList = [...new Set([port, ...PREVIEW_CANDIDATE_PORTS])].join(" ");
  const bakedExplicit = opts.start_cmd ? parseExplicitPort(opts.start_cmd) : null;
  const portsDefault = bakedExplicit != null ? String(bakedExplicit) : candidateList;

  const resolve = opts.start_cmd
    ? [`RUN_DIR="$ROOT"`, `START_CMD=${shq(opts.start_cmd)}`, `PORT_SRC="$START_CMD"`].join("\n")
    : [
        `__root_script() { node -e "var s=(require(process.argv[1]+'/package.json').scripts)||{};var o=['dev','start','server'];for(var i=0;i<o.length;i++){if(s[o[i]]){process.stdout.write(o[i]);process.exit(0)}}process.exit(1)" "$1" 2>/dev/null; }`,
        `__script_body() { node -e "var s=(require(process.argv[1]+'/package.json').scripts)||{};process.stdout.write(String(s[process.argv[2]]||''))" "$1" "$2" 2>/dev/null; }`,
        `__ws_has_dev() { node -e "var s=(require(process.argv[1]+'/package.json').scripts)||{};process.exit(s.dev?0:1)" "$1" 2>/dev/null; }`,
        `__ws_is_web() { node -e "var p=require(process.argv[1]+'/package.json');var s=p.scripts||{};if(!s.dev)process.exit(1);var d={},a=[p.dependencies,p.devDependencies];for(var i=0;i<a.length;i++){if(a[i])for(var k in a[i])d[k]=1;}var w=['next','vite','react-scripts','remix','@remix-run/dev','astro','@astrojs/node'];for(var j=0;j<w.length;j++){if(d[w[j]])process.exit(0)}process.exit(1)" "$1" 2>/dev/null; }`,
        `__has_workspaces() { node -e "var p=require(process.argv[1]+'/package.json');process.exit(p.workspaces?0:1)" "$1" 2>/dev/null; }`,
        `RUN_DIR=""`,
        `START_CMD=""`,
        `PORT_SRC=""`,
        `ROOT_SCRIPT="$(__root_script "$ROOT")"`,
        `if [ -n "$ROOT_SCRIPT" ]; then`,
        `  RUN_DIR="$ROOT"; START_CMD="npm run $ROOT_SCRIPT"; PORT_SRC="$(__script_body "$ROOT" "$ROOT_SCRIPT")"`,
        `elif __has_workspaces "$ROOT" || [ -d "$ROOT/apps" ]; then`,
        `  if [ -f "$ROOT/apps/web/package.json" ] && __ws_has_dev "$ROOT/apps/web"; then`,
        `    RUN_DIR="$ROOT/apps/web"`,
        `  else`,
        `    for __base in apps packages; do`,
        `      [ -n "$RUN_DIR" ] && break`,
        `      for __d in "$ROOT/$__base"/*/; do`,
        `        [ -d "$__d" ] || continue`,
        `        __d="\${__d%/}"`,
        `        if [ -f "$__d/package.json" ] && __ws_is_web "$__d"; then RUN_DIR="$__d"; break; fi`,
        `      done`,
        `    done`,
        `  fi`,
        `  if [ -n "$RUN_DIR" ]; then START_CMD="npm run dev"; PORT_SRC="$(__script_body "$RUN_DIR" dev)"; fi`,
        `fi`,
      ].join("\n");

  const rehydrateTimeout = opts.install_timeout_s ?? 600;
  const rehydrate = opts.shared_root
    ? [
        `if [ ! -d ${shq(opts.shared_root)}/node_modules ] && [ -f ${shq(opts.shared_root)}/package.json ]; then`,
        `  if [ -f ${shq(opts.shared_root)}/package-lock.json ]; then`,
        `    ( cd ${shq(opts.shared_root)} && timeout ${rehydrateTimeout} npm ci --prefer-offline --no-audit --no-fund --silent >/dev/null 2>&1 ) || true`,
        `  else`,
        `    ( cd ${shq(opts.shared_root)} && timeout ${rehydrateTimeout} npm install --prefer-offline --no-audit --no-fund --silent >/dev/null 2>&1 ) || true`,
        `  fi`,
        `fi`,
      ].join("\n")
    : "";

  const npmInstall = opts.allow_npm_install
    ? [
        `if [ ! -e "$RUN_DIR/node_modules" ] && [ ! -e "$ROOT/node_modules" ]; then`,
        `  ( cd "$ROOT" && timeout 240 npm install --prefer-offline --no-audit --no-fund --silent >/dev/null 2>&1 ) || true`,
        `fi`,
      ].join("\n")
    : `:`;

  return [
    `set +e`,
    `ROOT=${shq(repoDir)}`,
    `cd "$ROOT" 2>/dev/null || { printf '__PREVIEW__{"ready":0,"port":0,"reason":"no_repo_dir"}\\n'; exit 0; }`,
    resolve,
    `if [ -z "$START_CMD" ] || [ -z "$RUN_DIR" ]; then`,
    `  printf '__PREVIEW__{"ready":0,"port":0,"reason":"no_runnable_web_app"}\\n'; exit 0`,
    `fi`,
    `CAND='${candidateList}'`,
    `PORTS='${portsDefault}'`,
    `PORT_EXPLICIT="$(printf '%s' "$PORT_SRC" | grep -oE '(--port[= ]|-p[[:space:]]|PORT=)[0-9]+' | grep -oE '[0-9]+' | head -n1)"`,
    `[ -n "$PORT_EXPLICIT" ] && PORTS="$PORT_EXPLICIT $CAND"`,
    `PORT_PRIMARY="$(printf '%s' "$PORTS" | awk '{print $1}')"`,
    `cd "$RUN_DIR" 2>/dev/null || { printf '__PREVIEW__{"ready":0,"port":0,"reason":"no_run_dir"}\\n'; exit 0; }`,
    ...(opts.shared_root ? [rehydrate] : []),
    npmInstall,
    `BOOT_CMD="$START_CMD"`,
    `PREFLIX="$(printf '%s' "$PORT_SRC" | grep -oE '^[^&]*&&' | grep -E '(^|[[:space:]])(lint|test|typecheck|tsc|build)([[:space:]]|&)' | head -n1)"`,
    `if [ -n "$PREFLIX" ]; then`,
    `  __FW="$(RUN_DIR="$RUN_DIR" node -e 'try{var p=require(process.env.RUN_DIR+"/package.json");var d=Object.assign({},p.dependencies,p.devDependencies);if(d.next)console.log("next");else if(d.vite)console.log("vite");else if(d["react-scripts"])console.log("react-scripts");else if(d.remix||d["@remix-run/dev"])console.log("remix");else if(d.astro||d["@astrojs/node"])console.log("astro");}catch(e){}' 2>/dev/null)"`,
    `  case "$__FW" in`,
    `    next) BOOT_CMD="npx --no-install next dev -p $PORT_PRIMARY";;`,
    `    vite) BOOT_CMD="npx --no-install vite --port $PORT_PRIMARY";;`,
    `    react-scripts) BOOT_CMD="PORT=$PORT_PRIMARY npx --no-install react-scripts start";;`,
    `    remix) BOOT_CMD="npx --no-install remix dev";;`,
    `    astro) BOOT_CMD="npx --no-install astro dev --port $PORT_PRIMARY";;`,
    `  esac`,
    `elif [ -z "$PORT_EXPLICIT" ] && printf '%s' "$PORT_SRC" | grep -qE '^next (dev|start)([[:space:]]*)$'; then`,
    `  BOOT_CMD="$START_CMD -- -p $PORT_PRIMARY"`,
    `fi`,
    `case "$BOOT_CMD" in *" -p $PORT_PRIMARY"*) PORTS="$PORT_PRIMARY";; esac`,
    `PGID_FILE="/tmp/zavi-preview-$(printf '%s' "$RUN_DIR" | cksum | awk '{print $1}').pgid"`,
    `OLD_PGID="$(cat "$PGID_FILE" 2>/dev/null)"`,
    `REUSE=0`,
    `if [ -n "$OLD_PGID" ] && kill -0 -- "-$OLD_PGID" 2>/dev/null; then`,
    `  for p in $PORTS; do`,
    `    CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$p/" 2>/dev/null)`,
    `    case "$CODE" in 2*|3*) REUSE=1; break;; esac`,
    `  done`,
    `  if [ "$REUSE" = "0" ]; then`,
    `    kill -TERM -- "-$OLD_PGID" 2>/dev/null`,
    `    for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 -- "-$OLD_PGID" 2>/dev/null || break; sleep 1; done`,
    `    kill -KILL -- "-$OLD_PGID" 2>/dev/null`,
    `  fi`,
    `fi`,
    `LOG="$(mktemp)"`,
    ...(opts.sanitize_secret_env ? [sanitizeSecretEnvBashLines()] : []),
    `if [ "$REUSE" = "0" ]; then`,
    `  case "$PORT_SRC $BOOT_CMD" in *"next start"*) ;; *) if [ -f "$RUN_DIR/.next/BUILD_ID" ]; then rm -rf "$RUN_DIR/.next"; fi;; esac`,
    `  setsid nohup bash -c "$BOOT_CMD" > "$LOG" 2>&1 &`,
    `  printf '%s' "$!" > "$PGID_FILE"`,
    `fi`,
    `READY=0`,
    `BOUND_PORT=0`,
    `ANSWERED=0`,
    `FIRST_PORT="\${PORTS%% *}"`,
    `for i in $(seq 1 ${bootTimeout}); do`,
    `  for p in $PORTS; do`,
    `    CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$p/" 2>/dev/null)`,
    `    case "$CODE" in 2*|3*) READY=1; BOUND_PORT="$p"; break;; 4*|5*) [ "$p" = "$FIRST_PORT" ] && ANSWERED=1;; esac`,
    `  done`,
    `  [ "$READY" = "1" ] && break`,
    `  sleep 1`,
    `done`,
    `if [ "$READY" = "1" ]; then`,
    `  printf '__PREVIEW__{"ready":1,"port":%s}\\n' "$BOUND_PORT"`,
    `elif [ "$ANSWERED" = "1" ]; then`,
    `  printf '__PREVIEW__{"ready":0,"port":0,"reason":"boot_timeout:server_error"}\\n'`,
    `else`,
    `  printf '__PREVIEW__{"ready":0,"port":0,"reason":"boot_timeout:port_unbound"}\\n'`,
    `fi`,
  ].join("\n");
}

export function parsePreviewResult(stdout: string): {
  ready: boolean;
  port: number;
  reason?: string;
} {
  const m = stdout.match(/__PREVIEW__(\{.*?\})\s*$/m);
  if (!m) return { ready: false, port: 0 };
  try {
    const s = JSON.parse(m[1]) as {
      ready?: number | boolean;
      port?: number;
      reason?: string;
    };
    const ready = s.ready === 1 || s.ready === true;
    const port = typeof s.port === "number" && s.port > 0 ? s.port : 0;
    const reason = typeof s.reason === "string" && s.reason ? s.reason : undefined;
    return { ready, port, reason };
  } catch {
    return { ready: false, port: 0 };
  }
}

export function buildPreviewDeadReason(
  parsed: { reason?: string },
  fallback = "boot_failed",
): string {
  return (parsed.reason || fallback).slice(0, 500);
}

export function parsePreviewBooted(stdout: string): boolean {
  return parsePreviewResult(stdout).ready;
}

export async function startPreviewServer(
  sandbox_id: string,
  port = PREVIEW_DEFAULT_PORT,
  opts: {
    repo_dir?: string;
    boot_timeout_seconds?: number;
    start_cmd?: string;
    allow_npm_install?: boolean;
    shared_root?: string;
    install_timeout_s?: number;
    sanitize_secret_env?: boolean;
  } = {},
): Promise<StartPreviewResult> {
  if (!previewEnabled()) {
    throw new Error("instant preview disabled (INSTANT_PREVIEW_ENABLED === '0')");
  }
  const bootTimeout = opts.boot_timeout_seconds ?? PREVIEW_BOOT_TIMEOUT_DEFAULT_S;
  const script = buildPreviewBootScript({
    port,
    boot_timeout_seconds: bootTimeout,
    repo_dir: opts.repo_dir,
    start_cmd: opts.start_cmd,
    allow_npm_install: opts.allow_npm_install,
    shared_root: opts.shared_root,
    install_timeout_s: opts.install_timeout_s,
    sanitize_secret_env: opts.sanitize_secret_env,
  });
  const rehydrateBudgetS = opts.shared_root ? opts.install_timeout_s ?? 600 : 0;
  const execTimeoutMs = (bootTimeout + PREVIEW_EXEC_HEADROOM_S + rehydrateBudgetS) * 1000;
  const res = await execCommand(sandbox_id, script, execTimeoutMs);
  const parsed = parsePreviewResult(res.stdout);
  if (!parsed.ready) {
    throw new PreviewBootError(
      `preview dev-server did not serve a 2xx within ${bootTimeout}s (exit=${res.exit_code})`,
      buildPreviewDeadReason(parsed),
    );
  }
  const boundPort = parsed.port > 0 ? parsed.port : port;
  const url = await getSandboxHost(sandbox_id, boundPort);
  return { url, port: boundPort };
}
