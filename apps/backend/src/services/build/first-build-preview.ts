import { isLiveEditPayload } from "@/services/build/live-edit";
import { execCommand } from "@/services/sandbox/e2b-client";
import { previewEnabled } from "@/services/sandbox/preview";
import {
  buildFirstBuildInstallScript,
  buildStopFirstBuildPreviewScript,
  FIRST_BUILD_INSTALL_TIMEOUT_S,
  FIRST_BUILD_REPO_DIR,
  installSiteDeps,
  runDepsInstall,
  type RepoDepsResult,
} from "./deps-install-script";

export { buildFirstBuildInstallScript, buildStopFirstBuildPreviewScript, FIRST_BUILD_INSTALL_TIMEOUT_S, FIRST_BUILD_REPO_DIR };
export type { RepoDepsResult };

export function isFirstBuildScaffold(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as { stage?: unknown; refine_mode?: unknown; repair_mode?: unknown; target?: { github_target_mode?: unknown } };
  return (
    p.stage === "scaffold" &&
    p.refine_mode !== true &&
    p.repair_mode !== true &&
    p.target?.github_target_mode !== "user_repo"
  );
}

export function isProvisionedBuildPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as { stage?: unknown; refine_mode?: unknown; repair_mode?: unknown };
  return p.stage === "scaffold" || p.stage === "build" || p.refine_mode === true || p.repair_mode === true;
}

async function runFirstBuildInstall(
  sandbox_id: string,
  exec: typeof execCommand,
  require_lockfile: boolean,
  fresh_app = false,
): Promise<RepoDepsResult> {
  const script = buildFirstBuildInstallScript(FIRST_BUILD_REPO_DIR, FIRST_BUILD_INSTALL_TIMEOUT_S, require_lockfile, fresh_app);
  return runDepsInstall((id, cmd, t) => exec(id, cmd, t), sandbox_id, script, FIRST_BUILD_INSTALL_TIMEOUT_S);
}

export async function installSiteRepoDeps(
  sandbox_id: string,
  exec: typeof execCommand = execCommand,
): Promise<RepoDepsResult> {
  return installSiteDeps(sandbox_id, (id, cmd, t) => exec(id, cmd, t));
}

export async function sandboxServesLivePreview(
  payload: unknown,
  safeVerify: () => Promise<boolean>,
  preview: () => boolean = previewEnabled,
): Promise<boolean> {
  if (isLiveEditPayload(payload)) return true;
  if (!preview()) return false;
  return previewServesBuildRepo(payload, await safeVerify().catch(() => true));
}

export function previewServesBuildRepo(payload: unknown, buildStageToo: boolean): boolean {
  if (isFirstBuildScaffold(payload)) return true;
  if (!buildStageToo || !payload || typeof payload !== "object") return false;
  const p = payload as { stage?: unknown; refine_mode?: unknown; target?: { github_target_mode?: unknown } };
  return (
    (p.stage === "scaffold" || p.stage === "build") &&
    p.refine_mode !== true &&
    p.target?.github_target_mode !== "user_repo"
  );
}

export async function prepareFirstBuildPreview(
  sandbox_id: string,
  exec: typeof execCommand = execCommand,
): Promise<{ ok: boolean; reason: string }> {
  const installed = await runFirstBuildInstall(sandbox_id, exec, false, true);
  if (!previewEnabled()) return { ok: false, reason: "disabled" };
  return installed;
}

export async function ensureProvisionedBuildDeps(
  sandbox_id: string,
  exec: typeof execCommand = execCommand,
): Promise<{ ok: boolean; reason: string }> {
  return runFirstBuildInstall(sandbox_id, exec, true);
}

export const FIRST_BUILD_HOME_PAGES = [
  "app/page.tsx",
  "app/page.jsx",
  "app/page.js",
  "src/app/page.tsx",
  "src/app/page.jsx",
  "src/app/page.js",
] as const;

export function isHomePagePath(path: string | undefined, repo_dir = FIRST_BUILD_REPO_DIR): boolean {
  if (!path) return false;
  let p = path.trim();
  if (p.startsWith(`${repo_dir}/`)) p = p.slice(repo_dir.length + 1);
  p = p.replace(/^(\.\/)+/, "").replace(/^\/+/, "");
  return (FIRST_BUILD_HOME_PAGES as readonly string[]).includes(p);
}

export function buildHomePageChangedScript(repo_dir = FIRST_BUILD_REPO_DIR): string {
  const dir = `'${repo_dir.replace(/'/g, "'\\''")}'`;
  return `cd ${dir} 2>/dev/null && git status --porcelain -- ${FIRST_BUILD_HOME_PAGES.join(" ")} 2>/dev/null | head -1 || true`;
}

export type SandboxWriteEvent = { tool: string; path?: string; sandbox_id: string };

export function createFirstBuildPreviewWriteHook(
  kick: () => void,
  exec: typeof execCommand = execCommand,
): (event: SandboxWriteEvent) => Promise<void> {
  let fired = false;
  return async (event) => {
    if (fired) return;
    if (event.tool !== "run_bash" && !isHomePagePath(event.path)) return;
    const res = await exec(event.sandbox_id, buildHomePageChangedScript(), 10_000).catch(() => null);
    if (fired || !res || res.stdout.trim().length === 0) return;
    fired = true;
    kick();
  };
}

export function firstBuildPreviewWriteHookFor(
  payload: unknown,
  kick: () => void,
  exec: typeof execCommand = execCommand,
): ((event: SandboxWriteEvent) => Promise<void>) | undefined {
  if (!isFirstBuildScaffold(payload) || !previewEnabled()) return undefined;
  const target = (payload as { target?: { github_full_name?: unknown } }).target;
  if (typeof target?.github_full_name !== "string" || target.github_full_name.length === 0) return undefined;
  return createFirstBuildPreviewWriteHook(kick, exec);
}

type PreviewRowClient = {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, val: string) => {
        eq: (col: string, val: string) => {
          maybeSingle: () => PromiseLike<{ data: unknown; error: unknown }>;
        };
      };
    };
  };
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ error: unknown }>;
};

export async function stopFirstBuildPreviewServer(
  sandbox_id: string,
  exec: typeof execCommand = execCommand,
): Promise<boolean> {
  const res = await exec(sandbox_id, buildStopFirstBuildPreviewScript(), 30_000).catch(() => null);
  return /__FBP__STOPPED/.test(res?.stdout ?? "");
}

export async function hideStaleFirstBuildPreview(
  tenant_id: string,
  repo_full_name: string,
  client: PreviewRowClient,
  sandbox_id: string,
  exec: typeof execCommand = execCommand,
): Promise<"hidden" | "none"> {
  await stopFirstBuildPreviewServer(sandbox_id, exec);
  const { data } = await client
    .from("tenant_sandbox")
    .select("id, preview_status")
    .eq("tenant_id", tenant_id)
    .eq("repo_full_name", repo_full_name)
    .maybeSingle();
  const row = data as { id?: string; preview_status?: string | null } | null;
  if (!row?.id || (row.preview_status !== "live" && row.preview_status !== "starting")) return "none";
  const { error } = await client.rpc("clear_sandbox_preview", { p_id: row.id, p_final_status: "dead" });
  return error ? "none" : "hidden";
}
