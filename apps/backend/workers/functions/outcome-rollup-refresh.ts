
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { resolveReportingTimezone } from "@/services/analytics/tenant-timezone";
import { getOutcomeMap } from "@/services/growth/booking-metrics/outcomes";
import { refreshOutcomeRollup, rollupNeedsRebuild } from "@/services/growth/booking-metrics/outcome-rollup";

export const OUTCOME_ROLLUP_EVENT = "outcome-rollup.refresh.requested";

export type SweepDeps = {
  listTenants: () => Promise<string[]>;
  tzOf: (tenant_id: string) => Promise<string>;
  isStale: (tenant_id: string, tz: string, now: Date) => Promise<boolean>;
  refresh: (tenant_id: string, tz: string) => Promise<unknown>;
  now: () => Date;
};

const realSweepDeps: SweepDeps = {
  async listTenants() {
    const { data, error } = await serviceClient()
      .from("booking_metric_config")
      .select("tenant_id")
      .eq("state", "confirmed")
      .not("outcome_confirmed_at", "is", null)
      .limit(5000);
    if (error) throw new Error(`outcome-rollup-refresh: tenant list failed: ${error.message}`);
    return ((data ?? []) as Array<{ tenant_id: string }>).map((r) => r.tenant_id);
  },
  tzOf: async (t) => (await resolveReportingTimezone(t)).tz,
  isStale: (t, tz, now) => rollupNeedsRebuild(t, tz, now),
  refresh: (t, tz) => refreshOutcomeRollup(t, tz),
  now: () => new Date(),
};

export async function sweepOutcomeRollups(deps: SweepDeps = realSweepDeps): Promise<{ checked: number; refreshed: number; errors: number }> {
  const tenants = await deps.listTenants();
  let refreshed = 0;
  let errors = 0;
  for (const t of tenants) {
    try {
      const tz = await deps.tzOf(t);
      if (!(await deps.isStale(t, tz, deps.now()))) continue;
      await deps.refresh(t, tz);
      refreshed += 1;
    } catch (e) {
      errors += 1;
      console.warn(`[outcome-rollup-refresh] tenant=${t} failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    }
  }
  return { checked: tenants.length, refreshed, errors };
}

export const outcomeRollupSweepFn = inngest.createFunction(
  { id: "outcome-rollup-sweep", concurrency: { limit: 1 } },
  { cron: "17 * * * *" },
  async ({ logger }) => {
    const r = await sweepOutcomeRollups();
    logger.info(`outcome-rollup-sweep: ${r.refreshed}/${r.checked} refreshed, ${r.errors} error(s)`);
    return r;
  },
);

export const outcomeRollupRefreshFn = inngest.createFunction(
  { id: "outcome-rollup-refresh", concurrency: { limit: 1, key: "event.data.tenant_id" }, retries: 1 },
  { event: OUTCOME_ROLLUP_EVENT },
  async ({ event, logger }) => {
    const tenant_id = event.data?.tenant_id;
    if (!tenant_id || typeof tenant_id !== "string") return { outcome: "no_tenant" };
    const tz = (await resolveReportingTimezone(tenant_id)).tz;
    if (!(await getOutcomeMap(tenant_id)).ok) return { outcome: "not_confirmed" };
    if (!(await rollupNeedsRebuild(tenant_id, tz, new Date()))) return { outcome: "current" };
    const row = await refreshOutcomeRollup(tenant_id, tz);
    logger.info(`outcome-rollup-refresh: tenant=${tenant_id} through ${row?.through_day ?? "-"}`);
    return { outcome: row ? "refreshed" : "not_confirmed" };
  },
);
