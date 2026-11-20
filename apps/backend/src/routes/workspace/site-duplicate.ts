
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { siteStore } from "@/services/sites/store";
import { siteDesignStore } from "@/services/sites/site-design-store";
import { siteWiring } from "@/services/sites/wiring";
import { createSiteRepoOps } from "@/services/sites/site-repo";
import { deleteSite } from "@/services/sites/teardown";
import { stampConductorOwner } from "@/services/agents/conductor-owner";
import { webBaseUrl } from "@/services/web-base";
import { pushFilesToDest, readSourceFiles, type FetchLike } from "@/services/provisioning/export-to-own-github";
import {
  DoubleBuildInFlight,
  ensureProvisionedGithubConnector,
  MAX_PRODUCT_BUILDS_PER_DAY,
  realResolveOwnerEmail,
  realStartProductBuildDeps,
  TooManyBuildsToday,
} from "@/services/agents/start-product-build";
import { DuplicateRefused, duplicateSite, type DuplicateSiteDeps } from "@/services/sites/site-duplicate";
import { isProductBuilderEnabled } from "@/agents/engineer/product-builder-flag";

const WRITE_ROLES = ["owner", "admin"] as const;
const SITE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function umbrellaToken(): string {
  const token = process.env.GITHUB_PROVISION_TOKEN ?? "";
  if (!token) throw new Error("GITHUB_PROVISION_TOKEN is not set");
  return token;
}

const fetchFn: FetchLike = (url, init) => (globalThis as unknown as { fetch: FetchLike }).fetch(url, init);

export function realDuplicateSiteDeps(): DuplicateSiteDeps {
  const repo = createSiteRepoOps();
  const build = realStartProductBuildDeps;
  return {
    canCreateSite: async () => {
      const on = await isProductBuilderEnabled().catch(() => false);
      if (!on) return "builder_off";
      const prereqs = await build.checkSitePrereqs().catch(() => ({ ok: false as const }));
      return prereqs.ok ? "ok" : "backend_unavailable";
    },
    findDone: async (tenant_id, source_site_id, request_key) => {
      const { data, error } = await tenantClient(asTenantId(tenant_id))
        .from("conductor_runs")
        .select("id, goal_graph")
        .eq("kind", "build_app")
        .eq("status", "done")
        .contains("goal_graph", JSON.stringify([{ payload: { duplicate_of: { site_id: source_site_id, request_key } } }]))
        .limit(1);
      if (error) throw new Error(`duplicate replay lookup failed: ${error.message}`);
      const row = (data as Array<{ id: string; goal_graph: Array<{ payload?: Record<string, unknown> }> }> | null)?.[0];
      if (!row) return null;
      const build = row.goal_graph.find((n) => n.payload?.stage === "build")?.payload ?? {};
      const site_id = typeof build.site_id === "string" ? build.site_id : null;
      if (!site_id) return null;
      return { site_id, conductor_run_id: row.id, name: typeof build.company_name === "string" ? build.company_name : "" };
    },
    store: siteStore(),
    designStore: siteDesignStore(),
    acquireRun: async ({ tenant_id, objective }) =>
      build.tryAcquireBuildSlot({
        tenant_id,
        objective,
        max_usd: 0,
        provision_estimate: 0,
        max_per_day: MAX_PRODUCT_BUILDS_PER_DAY,
        daily_cap_usd: await build.resolveDailyCap(tenant_id),
      }),
    finishRun: async ({ tenant_id, conductor_run_id, goal_graph }) => {
      const { data, error } = await tenantClient(asTenantId(tenant_id))
        .from("conductor_runs")
        .update({ status: "done", goal_graph: stampConductorOwner(goal_graph), updated_at: new Date().toISOString() })
        .eq("id", conductor_run_id)
        .eq("status", "provisioning")
        .select("id");
      if (error) throw new Error(`conductor_runs finish failed: ${error.message}`);
      if (!Array.isArray(data) || data.length === 0) throw new Error("the copy's run was stopped while it was being made");
    },
    failRun: async ({ tenant_id, conductor_run_id, reason }) => {
      try {
        await build.updateConductorRunStatus({ conductor_run_id, status: "failed", goal_graph: [], failure_reason: `The site could not be duplicated: ${reason}` });
      } catch {
        await build.cancelConductorRun?.(tenant_id, conductor_run_id);
      }
    },
    initStatic: async (tenant_id, site_id) => {
      const pooled = siteWiring().pooled;
      if (!pooled) throw new Error("the site backend is not configured");
      await pooled.initStatic(tenant_id, site_id);
    },
    repoOrg: () => repo.org(),
    ensureRepo: (name) => repo.ensureRepo(name),
    readRepo: async (full_name) => {
      const { files, modes } = await readSourceFiles(full_name, umbrellaToken(), fetchFn);
      return { files, modes };
    },
    pushRepo: async ({ full_name, files, modes, message }) => {
      const r = await pushFilesToDest(
        { dest_full_name: full_name, dest_branch: "main", files, modes, installToken: umbrellaToken(), commitMessage: message, guardExistingFiles: true, auth: "umbrella" },
        fetchFn,
      );
      return r.commit_sha;
    },
    ensureGithubConnector: (tenant_id, full_name) =>
      ensureProvisionedGithubConnector(tenant_id, full_name, "main", { siteRepo: true }),
    pauseSchedules: async (tenant_id, site_id, schedules) => {
      const { error } = await tenantClient(asTenantId(tenant_id))
        .from("site_function_schedules")
        .insert(schedules.map((sc) => ({ site_id, tenant_id, ...sc, enabled: false, generation: 0 })));
      if (error && (error as { code?: string }).code !== "23505") throw new Error(`paused schedules write failed: ${error.message}`);
    },
    clearSchedules: async (tenant_id, site_id) => {
      const { error } = await tenantClient(asTenantId(tenant_id)).from("site_function_schedules").delete().eq("site_id", site_id);
      if (error) throw new Error(`schedule cleanup failed: ${error.message}`);
    },
    deleteSite: async (tenant_id, site_id) => {
      await deleteSite(tenant_id, site_id);
    },
    webBase: () => {
      try {
        return webBaseUrl();
      } catch {
        return "";
      }
    },
    now: () => new Date(),
  };
}

export async function postSiteDuplicate(
  req: Request,
  res: Response,
  deps: () => DuplicateSiteDeps = realDuplicateSiteDeps,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth || !(await requireTenantRole(auth, WRITE_ROLES, res))) return;
  const source_site_id = String(req.params.site_id ?? "");
  if (!SITE_ID_RE.test(source_site_id)) {
    res.status(400).json({ error: { code: "invalid_site_id", message: "That is not a site id." } });
    return;
  }
  try {
    const owner_email = await realResolveOwnerEmail(auth.tenant_id, auth.user_id).catch(() => null);
    const key = req.get?.("Idempotency-Key") ?? null;
    const out = await duplicateSite({ tenant_id: auth.tenant_id, source_site_id, user_id: auth.user_id, owner_email, request_key: key }, deps());
    res.status(201).json(out);
  } catch (e) {
    if (e instanceof DuplicateRefused) {
      res.status(e.status).json({ error: { code: e.code, message: e.message } });
      return;
    }
    if (e instanceof DoubleBuildInFlight) {
      res.status(409).json({ error: { code: "build_already_in_progress", message: "A build is running. Duplicate the site when it finishes." } });
      return;
    }
    if (e instanceof TooManyBuildsToday) {
      res.status(429).json({ error: { code: "too_many_builds_today", message: "You've reached today's build limit. Try again tomorrow." } });
      return;
    }
    console.error(`[site-duplicate] tenant=${auth.tenant_id} site=${source_site_id}: ${(e as Error)?.message ?? e}`);
    res.status(502).json({ error: { code: "duplicate_failed", message: "The site could not be duplicated. Nothing was kept; try again." } });
  }
}
