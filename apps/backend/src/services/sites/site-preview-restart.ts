import type { SupabaseClient } from "@supabase/supabase-js";
import type { SiteRow, SiteSandboxReadyContext } from "./contract";
import { siteDeployedUrl } from "./site-build-status";

export type SitePreviewState = "starting" | "stopped";

export const SITE_PREVIEW_RESTART_WINDOW_MS = 5 * 60_000;

export function sitePreviewRestartable(site: SiteRow, run_status: unknown): boolean {
  return run_status === "done" && site.status === "building" && siteDeployedUrl(site) === null && !!site.github_full_name;
}

export function sitePreviewState(input: {
  site: SiteRow;
  run_status: unknown;
  preview_kind: "none" | "instant" | "final";
  sandbox_status?: string | null;
  sandbox_updated_at?: string | null;
  waking?: boolean;
  site_run_active?: boolean;
  restarting?: boolean;
  nowMs?: number;
}): SitePreviewState | null {
  if (input.preview_kind !== "none") return null;
  if (!sitePreviewRestartable(input.site, input.run_status)) return null;
  const nowMs = input.nowMs ?? Date.now();
  if (input.restarting === true) return "starting";
  if (input.waking === true || input.site_run_active === true) return "starting";
  if (input.sandbox_status === "starting") {
    const since = input.sandbox_updated_at ? Date.parse(input.sandbox_updated_at) : NaN;
    if (!Number.isFinite(since) || nowMs - since < SITE_PREVIEW_RESTART_WINDOW_MS) return "starting";
  }
  return "stopped";
}

export const SITE_RUN_IN_FLIGHT = ["provisioning", "active", "paused"] as const;

export async function activeSiteRunExists(
  client: Pick<SupabaseClient, "from">,
  tenant_id: string,
  site_id: string,
): Promise<boolean> {
  const { data, error } = await client
    .from("conductor_runs")
    .select("id")
    .eq("tenant_id", tenant_id)
    .eq("kind", "build_app")
    .in("status", [...SITE_RUN_IN_FLIGHT])
    .eq("goal_graph->0->payload->>site_id", site_id)
    .limit(1);
  if (error) return true;
  return ((data as unknown[] | null)?.length ?? 0) > 0;
}

export type SitePreviewRestartDeps = {
  reseed: (tenant_id: string, site: SiteRow, sha?: string) => Promise<string>;
  ready: (ctx: SiteSandboxReadyContext, opts?: { awaitReadiness?: boolean }) => Promise<"preview_starting" | "preview_failed" | void>;
};

async function realRestartDeps(): Promise<SitePreviewRestartDeps> {
  const [{ realReseedSiteSandbox }, { onSiteSandboxReady }] = await Promise.all([
    import("./sandbox-resolver"),
    import("./sandbox-ready"),
  ]);
  return {
    reseed: (tenant_id, site, sha) => realReseedSiteSandbox(tenant_id, site, sha),
    ready: (ctx, opts) => onSiteSandboxReady(ctx, undefined, { repoAlreadyReset: true, ...opts }),
  };
}

export async function restartSitePreview(
  input: {
    tenant_id: string;
    run_id: string;
    site: SiteRow;
    release?: () => Promise<void>;
    sha?: string;
    awaitReadiness?: boolean;
  },
  injected?: SitePreviewRestartDeps,
): Promise<void> {
  const { tenant_id, run_id, site } = input;
  const release = input.release ?? (async () => undefined);
  const repo = (site.github_full_name ?? "").trim();
  if (site.tenant_id !== tenant_id || !repo) {
    await release();
    throw new Error("site preview restart: the site has no repo of this workspace");
  }
  try {
    const deps = injected ?? (await realRestartDeps());
    const e2b_sandbox_id = await (input.sha ? deps.reseed(tenant_id, site, input.sha) : deps.reseed(tenant_id, site));
    const ctx = { tenant_id, run_id, site_id: site.id, repo_full_name: repo, e2b_sandbox_id };
    const boot = await (input.awaitReadiness ? deps.ready(ctx, { awaitReadiness: true }) : deps.ready(ctx));
    if (boot === "preview_failed") await release();
  } catch (e) {
    await release();
    throw e;
  }
}
