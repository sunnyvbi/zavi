import { asTenantId, globalClient, tenantClient } from "@/services/tenant-client";
import { logEvent } from "@/services/logging/logEvent";
import { priceForJob, type JobFacts } from "./job-prices";

export type FlatPricingDb = {
  runs: (tenantId: string) => { select: (cols: string) => any; update: (v: Record<string, unknown>) => any };
  config: () => { select: (cols: string) => any };
};

const defaultDb: FlatPricingDb = {
  runs: (tenantId) => tenantClient(asTenantId(tenantId)).from("agent_runs"),
  config: () => globalClient().from("system_config"),
};

export async function isFlatJobPricingOn(db: FlatPricingDb = defaultDb): Promise<boolean> {
  try {
    const { data, error } = await db.config().select("blob").eq("id", 1).maybeSingle();
    if (error) return true;
    const v = ((data as { blob?: Record<string, unknown> } | null)?.blob ?? {}).flat_job_pricing;
    return !(v === false || v === "false");
  } catch {
    return true;
  }
}

async function writePrice(db: FlatPricingDb, runId: string, tenantId: string, credits: number): Promise<void> {
  const { error } = await db
    .runs(tenantId)
    .update({ billed_credits: credits })
    .eq("id", runId)
    .eq("status", "running")
    .is("billed_credits", null);
  if (error) throw new Error(error.message);
}

export async function recordBilledCredits(
  input: { runId: string; tenantId: string; agentSlug: string; trigger: string; payload?: unknown; cronDedupeKey?: string | null },
  db: FlatPricingDb = defaultDb,
): Promise<{ jobId: string; credits: number } | null> {
  const facts: JobFacts = {
    agent_slug: input.agentSlug,
    trigger: input.trigger,
    payload:
      input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)
        ? (input.payload as Record<string, unknown>)
        : null,
    cron_dedupe_key: input.cronDedupeKey ?? null,
  };
  const price = priceForJob(facts);
  if (!price) return null;
  try {
    await writePrice(db, input.runId, input.tenantId, price.credits);
    return { jobId: price.id, credits: price.credits };
  } catch (first) {
    try {
      await writePrice(db, input.runId, input.tenantId, price.credits);
      return { jobId: price.id, credits: price.credits };
    } catch {
      void logEvent({
        level: "error",
        source: "billing.flat-pricing",
        code: "billed_credits_write_failed",
        error: first,
        tenant_id: input.tenantId,
        run_id: input.runId,
      });
      return null;
    }
  }
}

export async function recordBilledCreditsForRun(
  runId: string,
  tenantId: string,
  trigger: string,
  db: FlatPricingDb = defaultDb,
): Promise<void> {
  try {
    const { data, error } = await db
      .runs(tenantId)
      .select("agent_slug, payload, cron_dedupe_key")
      .eq("id", runId)
      .eq("status", "running")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return;
    const r = data as { agent_slug: string; payload: unknown; cron_dedupe_key: string | null };
    await recordBilledCredits(
      { runId, tenantId, agentSlug: r.agent_slug, trigger, payload: r.payload, cronDedupeKey: r.cron_dedupe_key },
      db,
    );
  } catch (e) {
    void logEvent({ level: "error", source: "billing.flat-pricing", code: "billed_credits_write_failed", error: e, tenant_id: tenantId, run_id: runId });
  }
}

export async function isRunFlatBilled(tenantId: string, runId: string, db: FlatPricingDb = defaultDb): Promise<boolean> {
  const { data, error } = await db.runs(tenantId).select("billed_credits").eq("id", runId).maybeSingle();
  if (error) throw new Error(`isRunFlatBilled: ${error.message}`);
  return (data as { billed_credits: number | null } | null)?.billed_credits != null;
}
