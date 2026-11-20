export const FIRST_BUILD_REPO_DIR = "/home/user/repo";
export const FIRST_BUILD_INSTALL_TIMEOUT_S = 600;

export const SITE_DEPS_INSTALL_TIMEOUT_S = 240;
export const SITE_DEPS_SYNC_TIMEOUT_MS = (SITE_DEPS_INSTALL_TIMEOUT_S + 30) * 1000;

export const DEPS_LEFT_NO_MODULES: ReadonlySet<string> = new Set(["nomodules", "notnpm", "nolock", "norepo"]);

export type RepoDepsResult = { ok: boolean; reason: string; stale?: boolean; lock_sha1?: string };

export type DepsExec = (sandbox_id: string, cmd: string, timeoutMs: number) => Promise<{ stdout: string }>;

export function buildStopFirstBuildPreviewScript(repo_dir = FIRST_BUILD_REPO_DIR, proc_root = "/proc"): string {
  const q = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
  return [
    `set +e`,
    `ROOT=${q(repo_dir)}`,
    `mypg=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')`,
    `victims=""`,
    `for d in ${q(proc_root)}/[0-9]*; do`,
    `  c=$(readlink "$d/cwd" 2>/dev/null) || continue`,
    `  case "$c" in "$ROOT"|"$ROOT"/*) victims="$victims \${d##*/}";; esac`,
    `done`,
    `groups=""`,
    `for p in $victims; do`,
    `  pg=$(ps -o pgid= -p "$p" 2>/dev/null | tr -d ' ')`,
    `  [ -z "$pg" ] && continue`,
    `  [ "$pg" = "$mypg" ] && continue`,
    `  if [ "$pg" != "1" ] && [ "$pg" != "0" ]; then groups="$groups $pg"; kill -TERM -- "-$pg" >/dev/null 2>&1 || true; fi`,
    `  kill -TERM "$p" >/dev/null 2>&1 || true`,
    `done`,
    `sleep 1`,
    `for pg in $groups; do kill -KILL -- "-$pg" >/dev/null 2>&1 || true; done`,
    `for p in $victims; do`,
    `  pg=$(ps -o pgid= -p "$p" 2>/dev/null | tr -d ' ')`,
    `  [ -z "$pg" ] && continue`,
    `  [ "$pg" = "$mypg" ] && continue`,
    `  kill -KILL "$p" >/dev/null 2>&1 || true`,
    `done`,
    `echo __FBP__STOPPED`,
  ].join("\n");
}

export function buildFirstBuildInstallScript(
  repo_dir = FIRST_BUILD_REPO_DIR,
  timeout_s = FIRST_BUILD_INSTALL_TIMEOUT_S,
  require_lockfile = false,
  fresh_app = false,
): string {
  const dir = `'${repo_dir.replace(/'/g, "'\\''")}'`;
  return [
    `cd ${dir} 2>/dev/null || { echo __FBP__NOREPO; exit 0; }`,
    ...(fresh_app ? [`rm -rf .next`] : []),
    `if [ -d node_modules ] && [ -f package-lock.json ] && [ "$(cat node_modules/.zavi-lock 2>/dev/null)" != "$( (sha1sum package-lock.json 2>/dev/null || shasum package-lock.json) | cut -c1-40)" ]; then echo "__ZAVI_DEPS_STALE=$( (sha1sum package-lock.json 2>/dev/null || shasum package-lock.json) | cut -c1-40)"; ( ${buildStopFirstBuildPreviewScript(repo_dir)}\n) >/dev/null 2>&1 || true; rm -rf node_modules; fi`,
    `if [ ! -d node_modules ] && { [ -f pnpm-lock.yaml ] || [ -f yarn.lock ]; }; then echo __FBP__NOTNPM; exit 0; fi`,
    ...(require_lockfile ? [`if [ ! -d node_modules ] && [ ! -f package-lock.json ]; then echo __FBP__NOLOCK; exit 0; fi`] : []),
    `if [ ! -d node_modules ] && [ -f package.json ]; then`,
    `  if [ -f package-lock.json ]; then timeout ${timeout_s} npm ci --prefer-offline --no-audit --no-fund --silent >/dev/null 2>&1 || rm -rf node_modules;`,
    `  else timeout ${timeout_s} npm install --prefer-offline --no-audit --no-fund --silent >/dev/null 2>&1 || rm -rf node_modules; fi`,
    `fi`,
    `if [ -d node_modules ] && [ -f package-lock.json ]; then (sha1sum package-lock.json 2>/dev/null || shasum package-lock.json) | cut -c1-40 > node_modules/.zavi-lock; fi`,
    `if [ -d node_modules ]; then echo __FBP__OK; else echo __FBP__NOMODULES; fi`,
  ].join("\n");
}

export function buildSiteDepsInstallScript(repo_dir = FIRST_BUILD_REPO_DIR): string {
  return buildFirstBuildInstallScript(repo_dir, SITE_DEPS_INSTALL_TIMEOUT_S, true);
}

export function parseDepsInstallOutput(stdout: string): RepoDepsResult {
  const staleLock = /__ZAVI_DEPS_STALE=([0-9a-f]{40})?/.exec(stdout);
  const stale = staleLock ? { stale: true, ...(staleLock[1] ? { lock_sha1: staleLock[1] } : {}) } : {};
  if (/__FBP__OK/.test(stdout)) return { ok: true, reason: "ok", ...stale };
  const m = stdout.match(/__FBP__([A-Z]+)/);
  return { ok: false, reason: m ? m[1].toLowerCase() : "unknown", ...stale };
}

export async function runDepsInstall(exec: DepsExec, sandbox_id: string, script: string, timeout_s: number): Promise<RepoDepsResult> {
  const res = await exec(sandbox_id, script, (timeout_s + 30) * 1000).catch((e: unknown) => ({
    stdout: `__FBP__EXEC:${(e as Error)?.message ?? e}`,
  }));
  return parseDepsInstallOutput(res.stdout ?? "");
}

export function installSiteDeps(sandbox_id: string, exec: DepsExec): Promise<RepoDepsResult> {
  return runDepsInstall(exec, sandbox_id, buildSiteDepsInstallScript(), SITE_DEPS_INSTALL_TIMEOUT_S);
}
