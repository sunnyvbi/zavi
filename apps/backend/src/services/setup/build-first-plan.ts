import type { SupabaseClient } from "@supabase/supabase-js";
import type { SetupDraftStart } from "@/services/setup/draft-start";
import type { PrimarySiteWebsiteInput } from "@/services/sites/primary-site-website";

export type BuildFirstPlanDeps = {
  buildIntent: (tenant_id: string) => Promise<string>;
  setupOn: (tenant_id: string) => Promise<boolean>;
  isRefine: (tenant_id: string, conductor_run_id: string) => Promise<boolean>;
  skipSetupSteps: (tenant_id: string) => Promise<void>;
  hadPlanOrDraft: (tenant_id: string) => Promise<boolean>;
  recordWebsite: (tenant_id: string, conductor_run_id: string) => Promise<unknown>;
  research: (tenant_id: string) => Promise<unknown>;
  start: (tenant_id: string) => Promise<SetupDraftStart>;
};

export type BuildFirstPlanOutcome =
  | { started: false; reason: "not_fresh" | "setup_off" | "refine" | "already" }
  | { started: true; result: SetupDraftStart };

export async function startFirstPlanAfterBuild(
  tenant_id: string,
  conductor_run_id: string,
  deps: BuildFirstPlanDeps,
): Promise<BuildFirstPlanOutcome> {
  if ((await deps.buildIntent(tenant_id)) !== "fresh") return { started: false, reason: "not_fresh" };
  if (!(await deps.setupOn(tenant_id))) return { started: false, reason: "setup_off" };
  if (await deps.isRefine(tenant_id, conductor_run_id)) return { started: false, reason: "refine" };
  await deps.skipSetupSteps(tenant_id);
  if (await deps.hadPlanOrDraft(tenant_id)) return { started: false, reason: "already" };
  await deps.recordWebsite(tenant_id, conductor_run_id).catch(() => undefined);
  await deps.research(tenant_id);
  return { started: true, result: await deps.start(tenant_id) };
}

export type BuiltSiteAddressDeps = {
  siteByRun: (
    tenant_id: string,
    conductor_run_id: string,
  ) => Promise<{ id: string; status: string; live_url?: string | null; live_deploy_id?: string | null } | null>;
  record: (input: PrimarySiteWebsiteInput) => Promise<string>;
};

const NEVER_LIVE = new Set(["failed", "fell_back_old", "deleting", "deleted"]);

export async function recordBuiltSiteAddress(
  tenant_id: string,
  conductor_run_id: string,
  deps: BuiltSiteAddressDeps,
): Promise<string> {
  const site = await deps.siteByRun(tenant_id, conductor_run_id);
  if (!site) return "no_site";
  if (NEVER_LIVE.has(site.status) || !site.live_url || !site.live_deploy_id) return "not_live";
  return deps.record({ tenant_id, site_id: site.id, url: site.live_url });
}

export async function skipBuildSetupSteps(svc: SupabaseClient, tenant_id: string): Promise<void> {
  const now = new Date().toISOString();
  const ins = await svc.from("tenant_first_run_progress").upsert({ tenant_id }, { onConflict: "tenant_id", ignoreDuplicates: true });
  if (ins.error) throw new Error(`setup progress insert failed: ${ins.error.message}`);
  const docs = await svc
    .from("tenant_first_run_progress")
    .update({ setup_docs_at: now, setup_docs_skipped: true, updated_at: now })
    .eq("tenant_id", tenant_id)
    .is("setup_docs_at", null);
  if (docs.error) throw new Error(`setup docs skip failed: ${docs.error.message}`);
  const connectors = await svc
    .from("tenant_first_run_progress")
    .update({ setup_connectors_at: now, setup_connectors_skipped: true, updated_at: now })
    .eq("tenant_id", tenant_id)
    .is("setup_connectors_at", null);
  if (connectors.error) throw new Error(`setup connectors skip failed: ${connectors.error.message}`);
  const done = await svc
    .from("tenant_first_run_progress")
    .update({ setup_done_at: now, updated_at: now })
    .eq("tenant_id", tenant_id)
    .is("setup_done_at", null);
  if (done.error) throw new Error(`setup done mark failed: ${done.error.message}`);
}

export async function defaultBuildFirstPlanDeps(svc: SupabaseClient): Promise<BuildFirstPlanDeps> {
  const [{ getBoolSetting, getStringSetting }, { isRefineGraph }, { runIntakeResearch }, { startSetupDraftAttempt }, { asTenantId }, { readSetupDraftRuns }, { siteStore }, { recordPrimarySiteAsCompanyWebsite }] =
    await Promise.all([
      import("@/services/settings"),
      import("@/services/build/build-live-email"),
      import("@/routes/workspace/growth-intake-research"),
      import("@/services/setup/draft-start"),
      import("@/services/tenant-client"),
      import("@/services/setup/state"),
      import("@/services/sites/store"),
      import("@/services/sites/primary-site-website"),
    ]);
  return {
    buildIntent: (t) => getStringSetting("build_app_intent", t),
    setupOn: (t) => getBoolSetting("welcome_setup_enabled", t),
    async isRefine(t, id) {
      const { data, error } = await svc.from("conductor_runs").select("goal_graph").eq("id", id).eq("tenant_id", t).maybeSingle();
      if (error || !data) return true;
      return isRefineGraph((data as { goal_graph?: unknown }).goal_graph);
    },
    skipSetupSteps: (t) => skipBuildSetupSteps(svc, t),
    async hadPlanOrDraft(t) {
      const { data, error } = await svc.from("growth_plan").select("id").eq("tenant_id", t).limit(1);
      if (error) throw new Error(`plan read failed: ${error.message}`);
      if ((data ?? []).length > 0) return true;
      return (await readSetupDraftRuns(asTenantId(t))).length > 0;
    },
    recordWebsite: (t, id) =>
      recordBuiltSiteAddress(t, id, {
        siteByRun: (tenant, run) => siteStore().getByRun(tenant, run),
        record: (input) => recordPrimarySiteAsCompanyWebsite(input),
      }),
    research: (t) => runIntakeResearch(asTenantId(t)),
    start: (t) => startSetupDraftAttempt(t, { attempt: 1 }, svc),
  };
}
