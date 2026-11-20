
import { execCommand } from "@/services/sandbox/e2b-client";

export const SHARED_CLONE_DIR = "/home/user/repo";

export const SHARED_INSTALL_TIMEOUT_S = 600;

function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function buildSharedRootInstallSnippet(opts?: {
  shared_repo?: string;
  install_timeout_s?: number;
}): string {
  const shared = opts?.shared_repo ?? SHARED_CLONE_DIR;
  const t = opts?.install_timeout_s ?? SHARED_INSTALL_TIMEOUT_S;
  return [
    `NPMLOG="$(mktemp)"`,
    `if [ ! -e ${shq(shared)}/node_modules ] && [ -f ${shq(shared)}/package.json ]; then`,
    `  if [ -f ${shq(shared)}/package-lock.json ]; then`,
    `    ( cd ${shq(shared)} && timeout ${t} npm ci --prefer-offline --no-audit --no-fund ) >"$NPMLOG" 2>&1 || true`,
    `  else`,
    `    ( cd ${shq(shared)} && timeout ${t} npm install --prefer-offline --no-audit --no-fund ) >"$NPMLOG" 2>&1 || true`,
    `  fi`,
    `fi`,
  ].join("\n");
}

export function buildWorktreeDepsScript(opts: {
  worktree_path: string;
  shared_repo?: string;
  install_timeout_s?: number;
  lock_file?: string;
}): string {
  const shared = opts.shared_repo ?? SHARED_CLONE_DIR;
  const wt = opts.worktree_path;
  return [
    `set +e`,
    `if [ ! -f ${shq(shared)}/package.json ]; then echo __WTDEPS__SKIP:no_package_json; exit 0; fi`,
    `if [ -f ${shq(shared)}/pnpm-lock.yaml ] || [ -f ${shq(shared)}/yarn.lock ]; then echo __WTDEPS__SKIP:not_npm; exit 0; fi`,
    `exec 8>${shq(opts.lock_file ?? "/tmp/_praxis_deps.lock")}`,
    `if command -v flock >/dev/null 2>&1 && ! flock -w ${opts.install_timeout_s ?? SHARED_INSTALL_TIMEOUT_S} 8; then echo __WTDEPS__FAILED:lock_timeout; exit 0; fi`,
    buildSharedRootInstallSnippet({ shared_repo: shared, install_timeout_s: opts.install_timeout_s }),
    `command -v flock >/dev/null 2>&1 && flock -u 8`,
    `if [ ! -d ${shq(shared)}/node_modules ]; then`,
    `  CODE="$(grep -oE 'npm ERR! code [A-Z0-9_]+' "$NPMLOG" 2>/dev/null | tail -1 | grep -oE '[A-Z0-9_]+$')"`,
    `  echo "__WTDEPS__NOINSTALL:\${CODE:-unknown}"; exit 0`,
    `fi`,
    `GCD="$(cd ${shq(wt)} && git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"`,
    `if [ -z "$GCD" ]; then echo __WTDEPS__FAILED:no_git_dir; exit 0; fi`,
    `EX="$GCD/info/exclude"`,
    `mkdir -p "$GCD/info" 2>/dev/null`,
    `grep -qxF node_modules "$EX" 2>/dev/null || echo node_modules >> "$EX"`,
    `if ! grep -qxF node_modules "$EX" 2>/dev/null; then echo __WTDEPS__FAILED:no_exclude; exit 0; fi`,
    `if [ ! -e ${shq(wt)}/node_modules ] && [ ! -L ${shq(wt)}/node_modules ]; then ln -s ${shq(shared)}/node_modules ${shq(wt)}/node_modules; fi`,
    `echo __WTDEPS__OK`,
  ].join("\n");
}

export type WorktreeDepsOutcome =
  | "ok"
  | "skip_no_package_json"
  | "skip_not_npm"
  | "no_install"
  | "failed";

export function parseWorktreeDepsOutput(stdout: string): {
  outcome: WorktreeDepsOutcome;
  code?: string;
} {
  const m = (stdout || "").match(
    /__WTDEPS__(OK|SKIP:(no_package_json|not_npm)|NOINSTALL:([A-Za-z0-9_]+)|FAILED:([a-z_]+))/,
  );
  if (!m) return { outcome: "failed" };
  if (m[1] === "OK") return { outcome: "ok" };
  if (m[4]) return { outcome: "failed", code: m[4] };
  if (m[2] === "no_package_json") return { outcome: "skip_no_package_json" };
  if (m[2] === "not_npm") return { outcome: "skip_not_npm" };
  return { outcome: "no_install", code: m[3] };
}

export async function ensureRunWorktreeDeps(opts: {
  sandbox_id: string;
  worktree_path: string;
}): Promise<{ outcome: WorktreeDepsOutcome; code?: string; ms?: number }> {
  try {
    const r = await execCommand(
      opts.sandbox_id,
      buildWorktreeDepsScript({ worktree_path: opts.worktree_path }),
      (SHARED_INSTALL_TIMEOUT_S + 60) * 1000,
    );
    return { ...parseWorktreeDepsOutput(r.stdout), ms: r.ms };
  } catch {
    return { outcome: "failed" };
  }
}
