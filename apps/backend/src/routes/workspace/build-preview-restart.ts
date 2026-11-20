import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { serverClientFromBearer } from "@/services/supabase";
import { siteIdFromGraph } from "@/services/sites/site-run";
import { siteStore } from "@/services/sites/store";
import type { SiteRow } from "@/services/sites/contract";
import { activeSiteRunExists, restartSitePreview, sitePreviewRestartable } from "@/services/sites/site-preview-restart";
import { claimSiteLease, releaseSiteLease, type SiteLeaseClaim } from "@/services/sites/site-preview-lease";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WRITE_ROLES = ["owner", "admin"] as const;

type RunRow = { id: string; status: string | null; goal_graph: unknown };

export type BuildPreviewRestartDeps = {
  loadRun: (access_token: string, tenant_id: string, run_id: string) => Promise<RunRow | null>;
  hasActiveSiteRun: (access_token: string, tenant_id: string, site_id: string) => Promise<boolean>;
  loadSite: (tenant_id: string, site_id: string) => Promise<SiteRow | null>;
  claimRestart: (tenant_id: string, site_id: string) => Promise<SiteLeaseClaim>;
  releaseRestart: (tenant_id: string, site_id: string, token: string) => Promise<void>;
  restart: (input: { tenant_id: string; run_id: string; site: SiteRow; release: () => Promise<void> }) => Promise<void>;
};

const realDeps: BuildPreviewRestartDeps = {
  async loadRun(access_token, tenant_id, run_id) {
    const { data, error } = await serverClientFromBearer(access_token)
      .from("conductor_runs")
      .select("id, status, goal_graph")
      .eq("tenant_id", tenant_id)
      .eq("kind", "build_app")
      .eq("id", run_id)
      .maybeSingle();
    if (error) throw new Error(`build run read failed: ${error.message}`);
    return (data as RunRow | null) ?? null;
  },
  hasActiveSiteRun: (access_token, tenant_id, site_id) =>
    activeSiteRunExists(serverClientFromBearer(access_token), tenant_id, site_id),
  loadSite: (tenant_id, site_id) => siteStore().get(tenant_id, site_id),
  claimRestart: (tenant_id, site_id) => claimSiteLease(tenant_id, site_id, "restart"),
  releaseRestart: (tenant_id, site_id, token) => releaseSiteLease(tenant_id, site_id, { token }),
  restart: (input) => restartSitePreview(input),
};

export function makePostRestartBuildPreview(deps: BuildPreviewRestartDeps = realDeps) {
  return async function postRestartBuildPreview(req: Request, res: Response): Promise<void> {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    if (!(await requireTenantRole(auth, WRITE_ROLES, res))) return;
    const runId = typeof req.body?.run_id === "string" ? req.body.run_id.trim().toLowerCase() : "";
    if (!UUID_RE.test(runId)) {
      res.status(400).json({ error: { code: "bad_request", message: "run_id must be a uuid" } });
      return;
    }
    try {
      const run = await deps.loadRun(auth.access_token, auth.tenant_id, runId);
      const siteId = run ? siteIdFromGraph(run.goal_graph) : null;
      const site = siteId ? await deps.loadSite(auth.tenant_id, siteId) : null;
      if (!run || !site || site.tenant_id !== auth.tenant_id) {
        res.status(404).json({ error: { code: "build_not_found", message: "build not found" } });
        return;
      }
      if (!sitePreviewRestartable(site, run.status)) {
        res.status(409).json({
          error: { code: "preview_not_restartable", message: "This build's preview can't be restarted." },
        });
        return;
      }
      const tenant_id = auth.tenant_id;
      const claim = await deps.claimRestart(tenant_id, site.id);
      if (claim.token === null) {
        if (claim.held === "restart" || claim.held === "wake") {
          res.status(202).json({ ok: true, preview_state: "starting" });
          return;
        }
        res.status(409).json({
          error: { code: "build_in_progress", message: "A change to this site is running. Try again when it finishes." },
        });
        return;
      }
      const token = claim.token;
      const release = () => deps.releaseRestart(tenant_id, site.id, token);
      if (await deps.hasActiveSiteRun(auth.access_token, tenant_id, site.id)) {
        await release();
        res.status(409).json({
          error: { code: "build_in_progress", message: "A change to this site is running. Try again when it finishes." },
        });
        return;
      }
      void deps.restart({ tenant_id, run_id: run.id, site, release }).catch((e) => {
        console.warn(`[build-preview-restart] restart failed for site=${site.id}: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
      });
      res.status(202).json({ ok: true, preview_state: "starting" });
    } catch (e) {
      console.warn(`[build-preview-restart] ${(e as Error)?.message ?? e}`);
      res.status(500).json({ error: { code: "preview_restart_failed", message: "Something went wrong. Try again." } });
    }
  };
}

export const postRestartBuildPreview = makePostRestartBuildPreview();
