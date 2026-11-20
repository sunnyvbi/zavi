import { staffCrossTenantClient } from "@/services/tenant-client";
import {
  isRefundableSetupDraft, setupDraftAttempt, setupDraftKey, SETUP_DRAFT_MAX_ATTEMPTS, SETUP_DRAFT_IN_FLIGHT,
  type SetupDraftRun,
} from "@/services/growth/setup-draft";

const staffDb = () => staffCrossTenantClient("staff retry of a failed setup draft: one tenant's plan state");

export type StaffRetryRun = SetupDraftRun & { tenant_id: string; payload: unknown };
type PreparedRetry = { existing: string } | { attempt: 2 | 3; payload: Record<string, unknown> };

export async function prepareStaffDraftRetry(run: StaffRetryRun): Promise<PreparedRetry | null> {
  const payload = (run.payload && typeof run.payload === "object" ? run.payload : {}) as Record<string, unknown>;
  const setupLike = run.agent_slug === "cgo" && (
    payload.origin === "setup_draft" || run.cron_dedupe_key?.includes(":setup")
  );
  if (!setupLike) return null;
  if (run.enqueued_by !== null || !isRefundableSetupDraft(run.tenant_id, run)
    || payload.stage !== "draft_strategy" || payload.origin !== "setup_draft") {
    throw new Error("This is not a refundable setup draft. Use the workspace's plan flow.");
  }
  if (!["dispatch_error", "parse_failed", "failed", "error"].includes(run.status)) {
    throw new Error("Only a failed setup draft can be retried here.");
  }
  const attempt = setupDraftAttempt(run.tenant_id, run.cron_dedupe_key)! + 1;
  if (attempt > SETUP_DRAFT_MAX_ATTEMPTS) {
    throw new Error("All three refunded setup attempts are used. A paid retry needs the founder's explicit choice in setup.");
  }
  const existing = await readStaffDraftRetryTarget(run.tenant_id, attempt);
  if (existing) return { existing };

  const db = staffDb();
  const [plan, latest, active, generation, delivery] = await Promise.all([
    db.from("growth_plan").select("id").eq("tenant_id", run.tenant_id).eq("status", "live").limit(1).maybeSingle(),
    db.from("agent_runs").select("id").eq("tenant_id", run.tenant_id).eq("agent_slug", "cgo")
      .like("cron_dedupe_key", `cgo:draft:${run.tenant_id}:%`)
      .order("enqueued_at", { ascending: false }).order("id", { ascending: false }).limit(1).maybeSingle(),
    db.from("agent_runs").select("id").eq("tenant_id", run.tenant_id).eq("agent_slug", "cgo")
      .like("cron_dedupe_key", `cgo:draft:${run.tenant_id}:%`).in("status", [...SETUP_DRAFT_IN_FLIGHT]).limit(1).maybeSingle(),
    db.from("growth_strategy_generation").select("reset_at").eq("tenant_id", run.tenant_id).limit(1).maybeSingle(),
    db.from("growth_strategy_delivery").select("phase, artifact").eq("tenant_id", run.tenant_id)
      .eq("run_id", run.id).limit(1).maybeSingle(),
  ]);
  if ([plan, latest, active, generation, delivery].some(r => r.error)) {
    throw new Error("Could not verify the current plan state. Retry after the read succeeds.");
  }
  if (active.data) throw new Error("A plan draft is still in progress. Wait for that run to finish.");
  if (plan.data) throw new Error("This workspace already has a live plan. No new setup run was started.");
  if (!latest.data || latest.data.id !== run.id) {
    throw new Error("A newer plan draft exists. Open that run instead of retrying this older draft.");
  }
  if (generation.data?.reset_at && (!run.enqueued_at
    || Date.parse(generation.data.reset_at) >= Date.parse(run.enqueued_at))) {
    throw new Error("The founder reset this strategy. Use the current setup flow instead.");
  }
  if (delivery.data?.phase === "superseded") throw new Error("This strategy was superseded. Use the current setup flow instead.");
  if (delivery.data?.artifact) {
    throw new Error("A saved strategy already exists. Use setup's save retry to deliver it without another model run.");
  }
  const nextPayload: Record<string, unknown> = { stage: "draft_strategy", origin: "setup_draft" };
  for (const key of ["research", "interview", "past_work"] as const) {
    if (payload[key] !== undefined) nextPayload[key] = payload[key];
  }
  return { attempt: attempt as 2 | 3, payload: nextPayload };
}

export async function readStaffDraftRetryTarget(tenant: string, attempt: number): Promise<string | null> {
  const { data, error } = await staffDb().from("agent_runs").select("id")
    .eq("tenant_id", tenant).eq("agent_slug", "cgo").eq("trigger", "a2a").is("enqueued_by", null)
    .eq("cron_dedupe_key", setupDraftKey(tenant, attempt)).limit(1).maybeSingle();
  if (error) throw new Error("Could not read the setup retry receipt.");
  return data?.id ?? null;
}
