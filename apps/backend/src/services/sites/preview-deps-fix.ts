import type { SiteRow } from "./contract";
import { SITE_REPO_DIR, VITE_DEV_PORT } from "./contract";
import { writeSitePreviewConfigCmd } from "./preview-picker";
import {
  PREVIEW_CONFIG_WRITE_TIMEOUT_MS,
  SITE_DEPS_SYNC_TIMEOUT_MS,
  SITE_DEV_START_CMD,
  STOP_DEV_SERVER_TIMEOUT_MS,
  STOP_TEMPLATE_DEV_SERVER_CMD,
  buildSiteDepsStaleCmd,
  buildSyncSiteDepsCmd,
  publishWhenReady,
  type SandboxReadyDeps,
} from "./sandbox-ready";

type ExecResult = { stdout: string; stderr: string; exit_code: number; timed_out?: boolean };

const FIX_HEADER = /^Fix (?:this error|these \d+ errors) in the preview:$/;
const ERROR_LINE = /^(?:\d+\. )?On (\/\S*): (.+)$/;
const UNRESOLVED_IMPORT = /Failed to resolve import "([^"]+)" from "[^"]+"/;
const DOWNSTREAM_OF_IMPORT = /(?:Failed to fetch dynamically imported module|error loading dynamically imported module)/i;
const BARE_PACKAGE = /^((?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*)(?:\/[^\s"']*)?$/;
const MAX_PACKAGE_NAME = 214;

function parseUnresolvedImports(message: string): { packages: string[]; bare: string[] } | null {
  const lines = String(message ?? "").split("\n");
  if (!FIX_HEADER.test((lines[0] ?? "").trim())) return null;
  const packages = new Set<string>();
  const bare = new Set<string>();
  for (const raw of lines.slice(1)) {
    if (!raw.trim() || /^\s/.test(raw)) continue;
    const line = ERROR_LINE.exec(raw.trim());
    if (!line) return null;
    const imp = UNRESOLVED_IMPORT.exec(line[2]);
    if (imp) {
      const pkg = BARE_PACKAGE.exec(imp[1]);
      if (!pkg || pkg[1].length > MAX_PACKAGE_NAME) return null;
      packages.add(pkg[1]);
      if (pkg[1] === imp[1]) bare.add(pkg[1]);
      continue;
    }
    if (DOWNSTREAM_OF_IMPORT.test(line[2])) continue;
    return null;
  }
  return packages.size > 0 ? { packages: [...packages].sort(), bare: [...bare].sort() } : null;
}

export function unresolvedPackageImports(message: string): string[] | null {
  return parseUnresolvedImports(message)?.packages ?? null;
}

export function packagesInstallableFromLock(packageJson: string, packageLock: string, packages: readonly string[]): boolean {
  let manifest: { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
  let lock: { packages?: Record<string, unknown>; dependencies?: Record<string, unknown> };
  try {
    manifest = JSON.parse(packageJson);
    lock = JSON.parse(packageLock);
  } catch {
    return false;
  }
  if (!manifest || typeof manifest !== "object" || !lock || typeof lock !== "object") return false;
  const own = (o: unknown, k: string) => !!o && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
  return packages.every(
    (p) =>
      (own(manifest.dependencies, p) || own(manifest.devDependencies, p)) &&
      (own(lock.packages, `node_modules/${p}`) || own(lock.dependencies, p)),
  );
}

function packageList(packages: readonly string[]): string {
  for (const p of packages) {
    if (!BARE_PACKAGE.test(p) || p.includes("/") !== p.startsWith("@")) throw new Error(`invalid package name ${p}`);
  }
  return packages.map((p) => `'${p}'`).join(" ");
}

export const PREVIEW_DEPS_FIX_MARKER = `${SITE_REPO_DIR}/.git/zavi-preview-deps-fix`;
export const PREVIEW_DEPS_FIX_REPEAT_WINDOW_MS = 15 * 60_000;

export function buildPreviewDepsCheckCmd(packages: readonly string[], repo_dir: string = SITE_REPO_DIR): string {
  const list = packageList(packages);
  return [
    `( ${buildSiteDepsStaleCmd(repo_dir)}\n)`,
    `cd ${quoted(repo_dir)} 2>/dev/null || exit 0`,
    `for __p in ${list}; do [ -f "node_modules/$__p/package.json" ] || echo "__missing=$__p"; done`,
    `[ -f ${quoted(PREVIEW_DEPS_FIX_MARKER)} ] && echo "__marker=$(head -n 1 ${quoted(PREVIEW_DEPS_FIX_MARKER)})"`,
    `exit 0`,
  ].join("\n");
}

export function buildPreviewDepsMarkerCmd(packages: readonly string[], at: number): string {
  packageList(packages);
  return `printf '%s\\n' ${quoted(`${Math.floor(at)} ${packages.join(",")}`)} > ${quoted(PREVIEW_DEPS_FIX_MARKER)}`;
}

export function buildPreviewDepsRepairCmd(packages: readonly string[], repo_dir: string = SITE_REPO_DIR): string {
  const list = packageList(packages);
  const dir = quoted(repo_dir);
  return [
    `cd ${dir} 2>/dev/null || { echo __FBP__NOREPO; exit 0; }`,
    `for __p in ${list}; do [ -f "node_modules/$__p/package.json" ] || { rm -f node_modules/.zavi-lock; break; }; done`,
    `( ${buildSyncSiteDepsCmd(repo_dir)}\n) || true`,
    `for __p in ${list}; do [ -f "node_modules/$__p/package.json" ] || echo "__missing=$__p"; done`,
  ].join("\n");
}

export type PreviewDepsFixDeps = {
  loadSite: (tenant_id: string, conductor_run_id: string) => Promise<SiteRow | null>;
  siteRunActive: (tenant_id: string, site_id: string) => Promise<boolean>;
  loadSandbox: (tenant_id: string, repo_full_name: string) => Promise<{ e2b_sandbox_id: string | null; status: string | null } | null>;
  claimLease: (tenant_id: string, site_id: string) => Promise<string | null>;
  releaseLease: (tenant_id: string, site_id: string, token: string) => Promise<void>;
  exec: (sandbox_id: string, cmd: string, timeoutMs: number) => Promise<ExecResult>;
  startPreview: SandboxReadyDeps["startPreview"];
  recordPreview: SandboxReadyDeps["recordPreview"];
  hostFor?: (sandbox_id: string, port: number) => Promise<string>;
  probeReady?: SandboxReadyDeps["probeReady"];
  sleep?: SandboxReadyDeps["sleep"];
  schedule: (p: Promise<unknown>) => void;
  now?: () => number;
  log?: (line: Record<string, unknown>) => void;
};

export type PreviewDepsFixOutcome =
  | { handled: false; reason: string }
  | { handled: true; packages: string[] };

export type PreviewDepsRepairResult = "restarted" | "install_failed" | "stop_failed" | "boot_failed";

const READ_TIMEOUT_MS = 15_000;

function quoted(path: string): string {
  return `'${path.replace(/'/g, "'\\''")}'`;
}

export async function tryPreviewDepsFix(
  input: {
    tenant_id: string;
    conductor_run_id: string;
    message: string;
    onRepairFailed?: (result: PreviewDepsRepairResult | "repair_threw") => Promise<unknown>;
  },
  deps: PreviewDepsFixDeps,
): Promise<PreviewDepsFixOutcome> {
  const log = deps.log ?? ((l) => console.info(JSON.stringify(l)));
  const now = deps.now ?? Date.now;
  const skip = (reason: string): PreviewDepsFixOutcome => {
    log({ evt: "preview_deps_fix", tenant_id: input.tenant_id, outcome: "skipped", reason });
    return { handled: false, reason };
  };
  const parsed = parseUnresolvedImports(input.message);
  if (!parsed) return { handled: false, reason: "not_unresolved_packages" };
  const { packages, bare } = parsed;

  const site = await deps.loadSite(input.tenant_id, input.conductor_run_id).catch(() => null);
  const repo = (site?.github_full_name ?? "").trim();
  if (!site || site.tenant_id !== input.tenant_id || site.status === "fell_back_old" || !repo) return skip("no_site");

  const row = await deps.loadSandbox(input.tenant_id, repo).catch(() => null);
  const sandbox_id = row?.e2b_sandbox_id ?? null;
  if (!sandbox_id || row?.status !== "active") return skip("no_running_sandbox");

  const read = async (file: string) => {
    const r = await deps.exec(sandbox_id, `cat ${quoted(`${SITE_REPO_DIR}/${file}`)}`, READ_TIMEOUT_MS).catch(() => null);
    return r && r.exit_code === 0 ? r.stdout : null;
  };
  const [manifest, lock] = await Promise.all([read("package.json"), read("package-lock.json")]);
  if (manifest === null || lock === null || !packagesInstallableFromLock(manifest, lock, packages)) return skip("undeclared_package");

  const check = await deps.exec(sandbox_id, buildPreviewDepsCheckCmd(packages), READ_TIMEOUT_MS).catch(() => null);
  const state = /^__deps=(ok|stale)$/m.exec(check?.stdout ?? "")?.[1];
  if (!check || check.exit_code !== 0 || check.timed_out || !state) return skip("install_check_failed");
  const lines = check.stdout.split("\n");
  const missing = lines.filter((l) => l.startsWith("__missing=")).map((l) => l.slice("__missing=".length));
  if (missing.length === 0 && !(state === "stale" && bare.length > 0)) return skip("packages_installed");
  const marker = /^__marker=(\d+) (\S+)$/.exec(lines.find((l) => l.startsWith("__marker=")) ?? "");
  const key = packages.join(",");
  if (marker && marker[2] === key && now() - Number(marker[1]) < PREVIEW_DEPS_FIX_REPEAT_WINDOW_MS) return skip("repeat_fast_fix");

  if (await deps.siteRunActive(input.tenant_id, site.id).catch(() => true)) return skip("site_run_active");
  const token = await deps.claimLease(input.tenant_id, site.id).catch(() => null);
  if (!token) return skip("lease_held");
  const release = () => deps.releaseLease(input.tenant_id, site.id, token).catch(() => undefined);

  const mark = await deps.exec(sandbox_id, buildPreviewDepsMarkerCmd(packages, now()), READ_TIMEOUT_MS).catch(() => null);
  if (!mark || mark.exit_code !== 0) {
    await release();
    return skip("marker_failed");
  }

  log({ evt: "preview_deps_fix", tenant_id: input.tenant_id, site_id: site.id, outcome: "started", packages, missing, deps: state });
  deps.schedule(
    repairPreviewDeps({ tenant_id: input.tenant_id, site_id: site.id, repo_full_name: repo, sandbox_id, packages }, deps)
      .catch(() => "repair_threw" as const)
      .then(async (result) => {
        log({ evt: "preview_deps_fix", tenant_id: input.tenant_id, site_id: site.id, outcome: result });
        await release();
        if (result !== "restarted" && input.onRepairFailed) await input.onRepairFailed(result);
      }),
  );
  return { handled: true, packages };
}

export async function repairPreviewDeps(
  p: { tenant_id: string; site_id: string; repo_full_name: string; sandbox_id: string; packages: readonly string[] },
  deps: Pick<PreviewDepsFixDeps, "exec" | "startPreview" | "recordPreview" | "probeReady" | "sleep" | "hostFor">,
): Promise<PreviewDepsRepairResult> {
  const record = (url: string | null, status: "starting" | "live" | "dead", port: number = VITE_DEV_PORT) =>
    deps.recordPreview({ tenant_id: p.tenant_id, repo_full_name: p.repo_full_name, url, port, status }).catch(() => false);
  if (!(await record(null, "starting"))) {
    console.warn(`[preview-deps] sandbox=${p.sandbox_id} fix skipped: the preview row could not be marked starting`);
    return "stop_failed";
  }
  const stop = await deps.exec(p.sandbox_id, STOP_TEMPLATE_DEV_SERVER_CMD, STOP_DEV_SERVER_TIMEOUT_MS).catch(() => null);
  if (!stop || stop.exit_code !== 0) {
    console.warn(`[preview-deps] sandbox=${p.sandbox_id} fix skipped: the running dev server did not stop`);
    const url = deps.hostFor ? await deps.hostFor(p.sandbox_id, VITE_DEV_PORT).catch(() => null) : null;
    await record(url, url ? "live" : "dead");
    return "stop_failed";
  }
  const install = await deps
    .exec(p.sandbox_id, buildPreviewDepsRepairCmd(p.packages), SITE_DEPS_SYNC_TIMEOUT_MS)
    .catch(() => null);
  const missing = (install?.stdout ?? "")
    .split("\n")
    .filter((l) => l.startsWith("__missing="))
    .map((l) => l.slice("__missing=".length));
  if (!install || install.exit_code !== 0 || install.timed_out || missing.length > 0 || /__FBP__(?:NOMODULES|NOLOCK|NOTNPM|NOREPO)\b/.test(install.stdout)) {
    console.warn(`[preview-deps] sandbox=${p.sandbox_id} still missing after install: ${missing.join(",") || "install did not run"}`);
    await record(null, "dead");
    return "install_failed";
  }
  const config = await deps.exec(p.sandbox_id, writeSitePreviewConfigCmd(), PREVIEW_CONFIG_WRITE_TIMEOUT_MS).catch(() => null);
  if (!config || config.exit_code !== 0 || config.timed_out) {
    console.warn(`[preview-deps] sandbox=${p.sandbox_id} preview config could not be written after the install`);
    await record(null, "dead");
    return "boot_failed";
  }
  try {
    const { url, port } = await deps.startPreview(p.sandbox_id, VITE_DEV_PORT, {
      repo_dir: SITE_REPO_DIR,
      start_cmd: SITE_DEV_START_CMD,
      sanitize_secret_env: true,
    });
    await record(url, "starting", port);
    await publishWhenReady({ tenant_id: p.tenant_id, repo_full_name: p.repo_full_name, url, port, site_id: p.site_id }, deps);
  } catch (e) {
    console.warn(`[preview-deps] sandbox=${p.sandbox_id} dev server did not start: ${(e as Error)?.message ?? e}`);
    await record(null, "dead");
    return "boot_failed";
  }
  return "restarted";
}

export async function realPreviewDepsFixDeps(): Promise<PreviewDepsFixDeps> {
  const [{ realRefineProductDeps }, { serviceClient }, { execCommand, getSandboxHost }, { startPreviewServer }, driver, lease, { activeSiteRunExists }] =
    await Promise.all([
      import("@/services/agents/refine-product"),
      import("@/services/supabase"),
      import("@/services/sandbox/e2b-client"),
      import("@/services/sandbox/preview"),
      import("@/services/agents/conductor-driver"),
      import("./site-preview-lease"),
      import("./site-preview-restart"),
    ]);
  return {
    hostFor: (sandbox_id, port) => getSandboxHost(sandbox_id, port),
    loadSite: async (tenant_id, run_id) => (realRefineProductDeps.loadSiteForRun ? realRefineProductDeps.loadSiteForRun(tenant_id, run_id) : null),
    siteRunActive: (tenant_id, site_id) => activeSiteRunExists(serviceClient(), tenant_id, site_id),
    loadSandbox: async (tenant_id, repo_full_name) => {
      const { data, error } = await serviceClient()
        .from("tenant_sandbox")
        .select("e2b_sandbox_id, status")
        .eq("tenant_id", tenant_id)
        .eq("repo_full_name", repo_full_name)
        .maybeSingle();
      if (error) throw new Error(`tenant_sandbox read failed: ${error.message}`);
      return (data as { e2b_sandbox_id: string | null; status: string | null } | null) ?? null;
    },
    claimLease: async (tenant_id, site_id) => (await lease.claimSiteLease(tenant_id, site_id, "restart")).token,
    releaseLease: (tenant_id, site_id, token) => lease.releaseSiteLease(tenant_id, site_id, { token }),
    exec: (id, cmd, t) => execCommand(id, cmd, t),
    startPreview: (id, port, opts) => startPreviewServer(id, port, opts),
    recordPreview: driver.recordSiteSandboxPreview,
    schedule: (p) => void p.catch((e) => console.warn(`[preview-deps] repair failed: ${(e as Error)?.message ?? e}`)),
  };
}
