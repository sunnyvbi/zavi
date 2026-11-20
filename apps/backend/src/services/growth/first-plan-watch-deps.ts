
import type { SupabaseClient } from "@supabase/supabase-js";
import { firstPlanReads, type FirstPlanWatchDeps } from "./first-plan-watch";
import { stalledSetupReads, type StalledSetupDeps } from "./stalled-setup";

export async function firstPlanWatchDeps(svc: SupabaseClient): Promise<FirstPlanWatchDeps> {
  const [{ startSetupDraftAttempt }, { getBoolSettingStrictResolved }, { alert, emailOpsAlert }, { logEvent }] = await Promise.all([
    import("@/services/setup/draft-start"),
    import("@/services/settings"),
    import("@/services/logging/alert"),
    import("@/services/logging/logEvent"),
  ]);
  return {
    reads: firstPlanReads(svc, (t) => getBoolSettingStrictResolved("welcome_setup_enabled", t)),
    start: (t, attempt) => startSetupDraftAttempt(t, { attempt, backstop: true }, svc),
    alert,
    emailAlert: emailOpsAlert,
    log: (e) => logEvent({ level: e.level, source: "first-plan-watch", code: e.code, tenant_id: e.tenant_id, run_id: e.run_id, message: e.message }),
  };
}

export async function stalledSetupDeps(svc: SupabaseClient): Promise<StalledSetupDeps> {
  const [{ getAppSetting, getBoolSettingStrictResolved, getStringSettingStrict }, { runIntakeResearch }, { skipBuildSetupSteps }, { asTenantId }, { logEvent }] =
    await Promise.all([
      import("@/services/settings"),
      import("@/routes/workspace/growth-intake-research"),
      import("@/services/setup/build-first-plan"),
      import("@/services/tenant-client"),
      import("@/services/logging/logEvent"),
    ]);
  const setupOn = (t: string) => getBoolSettingStrictResolved("welcome_setup_enabled", t);
  return {
    reads: stalledSetupReads(svc, {
      leaving: firstPlanReads(svc, setupOn).leaving,
      setupOn,
      buildIntent: (t) => getStringSettingStrict("build_app_intent", t),
    }),
    afterSetting: () => getAppSetting("first_plan_stalled_setup_minutes", null, { strict: true }),
    research: (t) => runIntakeResearch(asTenantId(t)),
    skipSetup: (t) => skipBuildSetupSteps(svc, t),
    log: (e) => logEvent({ level: e.level, source: "first-plan-watch", code: e.code, tenant_id: e.tenant_id, message: e.message }),
  };
}
