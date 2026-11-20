
import type { SiteSandbox } from "@/services/sites/contract";

export const INSTALL_CACHE_ROOT = "/home/user/.zavi-install-cache";
export const INSTALL_CACHE_KEEP = 2;
const MIN_FREE_KB = 2 * 1024 * 1024;
const KEY_RE = /^[0-9a-f]{24}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const DIR_RE = /^\/tmp\/site-[A-Za-z0-9-]+$/;
const SCOPE_RE = /^[0-9a-f-]{36}$/i;
const STEP_TIMEOUT_MS = 180_000;
const MAX_DIGESTS = 2_000;

const digests = new Map<string, string>();

export function __resetInstallDigests(): void {
  digests.clear();
}

function remember(id: string, digest: string): void {
  digests.delete(id);
  if (digests.size >= MAX_DIGESTS) {
    const oldest = digests.keys().next().value;
    if (oldest !== undefined) digests.delete(oldest);
  }
  digests.set(id, digest);
}

export function installCacheKeyScript(): string {
  return (
    "test -f package-lock.json && test -f package.json && " +
    "(for f in package.json package-lock.json npm-shrinkwrap.json .npmrc; do echo \"== $f\"; if [ -f \"$f\" ]; then cat \"$f\"; else echo '<absent>'; fi; done; " +
    "node -v; npm -v; uname -m; echo zavi-install-cache-v3) | sha256sum | cut -c1-24"
  );
}

export function treeDigestScript(base: string): string {
  return (
    `set -o pipefail; cd ${base} && test -d node_modules && ! test -L node_modules && ` +
    `test -z "$(find node_modules ! -type d ! -type f ! -type l -print -quit)" && ` +
    `{ find node_modules -printf '%y %m %p\\n' | LC_ALL=C sort; ` +
    `find node_modules -type l | LC_ALL=C sort | while IFS= read -r l; do printf 'L %s %s\\n' "$l" "$(readlink "$l")"; done; ` +
    `find node_modules -type f -exec sha256sum {} + | LC_ALL=C sort; } | sha256sum | cut -c1-64`
  );
}

export function restoreInstallScript(dir: string, key: string): string {
  const entry = `${INSTALL_CACHE_ROOT}/${key}`;
  return `set -e; test -f ${entry}/.done; touch ${entry}; rm -rf ${dir}/node_modules; cp -a ${entry}/node_modules ${dir}/node_modules`;
}

export function saveInstallScript(dir: string, key: string, token: string): string {
  const entry = `${INSTALL_CACHE_ROOT}/${key}`;
  const tmp = `${INSTALL_CACHE_ROOT}/.tmp-${token}`;
  const old = `${INSTALL_CACHE_ROOT}/.old-${token}`;
  return [
    "set -e",
    `mkdir -p ${INSTALL_CACHE_ROOT}`,
    `test "$(df -Pk ${INSTALL_CACHE_ROOT} | awk 'NR==2{print $4}')" -gt ${MIN_FREE_KB}`,
    `rm -rf ${tmp} && mkdir -p ${tmp}`,
    `cp -a ${dir}/node_modules ${tmp}/node_modules`,
    `touch ${tmp}/.done`,
    `if [ -e ${entry} ]; then mv -T ${entry} ${old}; fi`,
    `mv -T ${tmp} ${entry}`,
    `rm -rf ${old}`,
    `find ${INSTALL_CACHE_ROOT} -maxdepth 1 \\( -name '.tmp-*' -o -name '.old-*' \\) -mmin +30 -exec rm -rf {} + 2>/dev/null || true`,
    `ls -1dt ${INSTALL_CACHE_ROOT}/*/ 2>/dev/null | tail -n +${INSTALL_CACHE_KEEP + 1} | xargs -r rm -rf`,
  ].join("\n");
}

type Run = SiteSandbox["run"];

async function digestOf(run: Run, base: string): Promise<string | null> {
  try {
    const r = await run(treeDigestScript(base), { cwd: base, timeoutMs: STEP_TIMEOUT_MS });
    const d = r.exitCode === 0 && !r.timedOut && !r.transportError ? r.stdout.trim() : "";
    return DIGEST_RE.test(d) ? d : null;
  } catch {
    return null;
  }
}

export async function installCacheKey(run: Run, dir: string): Promise<string | null> {
  if (!DIR_RE.test(dir)) return null;
  try {
    const r = await run(installCacheKeyScript(), { cwd: dir, timeoutMs: 60_000 });
    const key = r.exitCode === 0 ? r.stdout.trim() : "";
    return KEY_RE.test(key) ? key : null;
  } catch {
    return null;
  }
}

export async function restoreInstall(run: Run, dir: string, key: string, scope: string): Promise<boolean> {
  if (!DIR_RE.test(dir) || !KEY_RE.test(key) || !SCOPE_RE.test(scope)) return false;
  const id = `${scope.toLowerCase()}:${key}`;
  const expected = digests.get(id);
  if (!expected) return false;
  let ok = false;
  try {
    const r = await run(restoreInstallScript(dir, key), { cwd: dir, timeoutMs: STEP_TIMEOUT_MS });
    ok = r.exitCode === 0 && !r.timedOut && !r.transportError && (await digestOf(run, dir)) === expected;
  } catch {
    ok = false;
  }
  if (ok) return true;
  digests.delete(id);
  console.warn(`[install-cache] event=restore_rejected scope=${scope} key=${key}`);
  await Promise.resolve(run(`rm -rf ${dir}/node_modules ${INSTALL_CACHE_ROOT}/${key}`, { cwd: dir, timeoutMs: 60_000 })).catch(() => undefined);
  return false;
}

export async function saveInstall(run: Run, dir: string, key: string, token: string, scope: string): Promise<void> {
  if (!DIR_RE.test(dir) || !KEY_RE.test(key) || !/^[A-Za-z0-9-]+$/.test(token) || !SCOPE_RE.test(scope)) return;
  const digest = await digestOf(run, dir);
  if (!digest) return;
  try {
    const r = await run(saveInstallScript(dir, key, token), { cwd: dir, timeoutMs: STEP_TIMEOUT_MS });
    if (r.exitCode === 0 && !r.timedOut && !r.transportError) remember(`${scope.toLowerCase()}:${key}`, digest);
  } catch {
  }
}
