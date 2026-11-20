
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { getBoolSetting } from "@/services/settings";
import { isFleetHalted } from "@/services/agents/fleet-halt";
import { isWorkerCronStopped } from "@/services/agents/cron-stopped";
import { mondayUtc } from "@/agents/research/persist-snapshot";
import {
  enqueueCompetitorScan,
  type PriorSnapshotRow,
} from "@/services/competitor-intel/scan";

export {
  MAX_PRIOR_CONTEXT_CHARS,
  RESEARCH_ASK,
  renderPriorContext,
  renderCustomBrandClause,
  enqueueCompetitorScan,
} from "@/services/competitor-intel/scan";
export type { PriorSnapshotRow } from "@/services/competitor-intel/scan";

type TenantRow = {
  id: string;
  display_name: string | null;
};

type TenantOutcome =
  | { status: "skipped"; reason: string; run_id?: never }
  | { status: "enqueued"; run_id: string | null };

async function loadLatestSnapshot(tenant_id: string): Promise<PriorSnapshotRow | null> {
  const sb = serviceClient();
  const { data, error } = await sb
    .from("competitor_snapshots")
    .select("week_bucket, landscape")
    .eq("tenant_id", tenant_id)
    .order("week_bucket", { ascending: false })
    .limit(1);
  if (error) {
    throw new Error(`competitor-intel-weekly: snapshot read failed: ${error.message}`);
  }
  return data && data.length > 0 ? (data[0] as PriorSnapshotRow) : null;
}

export const COMPETITOR_INTEL_WORKER_NAME = "competitor-intel-weekly";

export async function runForTenant(tenant: TenantRow): Promise<TenantOutcome> {
  if (isWorkerCronStopped(COMPETITOR_INTEL_WORKER_NAME)) {
    return { status: "skipped", reason: "cron stopped fleet-wide" };
  }

  const enabled = await getBoolSetting("competitor_intel_weekly_enabled", tenant.id);
  if (!enabled) {
    return { status: "skipped", reason: "competitor_intel_weekly_enabled=false (default)" };
  }

  if (await isFleetHalted()) {
    return { status: "skipped", reason: "fleet halt active" };
  }

  const prior = await loadLatestSnapshot(tenant.id);
  const week_bucket = mondayUtc(new Date());
  const { run_id } = await enqueueCompetitorScan(tenant.id, {
    dedupe_key: `competitor-intel-weekly:${tenant.id}:${week_bucket}`,
    trigger: "cron",
    prior,
  });

  return { status: "enqueued", run_id };
}

export const competitorIntelWeeklyFn = inngest.createFunction(
  {
    id: "competitor-intel-weekly",
    concurrency: 1,
  },
  { cron: "0 9 * * 1" },
  async ({ step }) => {
    const halted = await step.run("check-fleet-halt", async () => isFleetHalted());
    if (halted) {
      return { halted: true, scanned: 0, enqueued: 0, skipped: 0 };
    }

    const tenants = await step.run("scan-tenants", async () => {
      const svc = serviceClient();
      const { data, error } = await svc.from("tenants").select("id, display_name");
      if (error) {
        throw new Error(`competitor-intel-weekly: tenant scan failed: ${error.message}`);
      }
      return (data ?? []) as TenantRow[];
    });

    let enqueued = 0;
    let skipped = 0;
    const enqueuedRuns: Array<{ tenant_id: string; run_id: string | null }> = [];
    const skippedTenants: Array<{ tenant_id: string; reason: string }> = [];

    for (const tenant of tenants) {
      try {
        const outcome = (await step.run(`tenant-${tenant.id}`, () =>
          runForTenant(tenant),
        )) as TenantOutcome;

        if (outcome.status === "skipped") {
          skipped++;
          skippedTenants.push({ tenant_id: tenant.id, reason: outcome.reason });
        } else {
          enqueued++;
          enqueuedRuns.push({ tenant_id: tenant.id, run_id: outcome.run_id });
          console.info(
            `[competitor-intel-weekly] tenant=${tenant.id} enqueued research run=${outcome.run_id}`,
          );
        }
      } catch (e) {
        skipped++;
        skippedTenants.push({ tenant_id: tenant.id, reason: (e as Error).message });
        console.error(
          `[competitor-intel-weekly] tenant=${tenant.id} threw: ${(e as Error).message}`,
        );
      }
    }

    return {
      halted: false,
      scanned: tenants.length,
      enqueued,
      skipped,
      enqueued_runs: enqueuedRuns,
      skipped_tenants: skippedTenants,
    };
  },
);
