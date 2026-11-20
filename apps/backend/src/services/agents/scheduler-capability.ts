import { isWorkerCronStopped } from "./cron-stopped";
import { nextLocalCronFire } from "../../../workers/functions/cron-match";
import { getBoolSettingStrictResolved } from "@/services/settings";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { firstRunKey } from "@/services/growth/auto-first-run";

export const GROWTH_SCHEDULED_WORKERS: ReadonlyArray<{
  worker: string;
  cron: string;
}> = [
  { worker: "channel-sweep", cron: "0 7 * * *" },
  { worker: "goal-reconcile", cron: "30 13 * * *" },
  { worker: "cgo-daily-check", cron: "0 14 * * *" },
  { worker: "ad-budget-reconcile", cron: "7 * * * *" },
  { worker: "cgo-budget-review", cron: "23 * * * *" },
  { worker: "ad-spend-controller", cron: "41 * * * *" },
];

export type ScheduledWorkerCapability = {
  worker: string;
  allowlisted: boolean;
  blocking_reason: "worker_allowlist" | null;
  cron: string;
  timezone: "UTC";
  next_nominal_tick_at: string | null;
};

export type SchedulerCapability = {
  version: 1;
  observed_at: string;
  autopilot_enabled: boolean;
  scheduled_workers: ScheduledWorkerCapability[];
  event_driven: {
    paid_first_run: {
      trigger: "cgo_strategy_apply";
      used: boolean | null;
      eligibility: "not_evaluated";
      next_nominal_tick_at: null;
    };
    free_preview: {
      trigger: "cgo_strategy_apply";
      eligibility: "not_evaluated";
      next_nominal_tick_at: null;
    };
  };
};

export type SchedulerCapabilityDeps = {
  now: () => Date;
  autopilotEnabled: (tenant_id: string) => Promise<boolean>;
  firstRunUsed: (tenant_id: string) => Promise<boolean | null>;
  workerStopped: (worker: string) => boolean;
};

async function readFirstRunUsed(tenant_id: string): Promise<boolean | null> {
  try {
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("agent_runs")
      .select("id")
      .eq("cron_dedupe_key", firstRunKey(tenant_id))
      .limit(1);
    if (error) return null;
    return (data ?? []).length > 0;
  } catch {
    return null;
  }
}

export const defaultSchedulerCapabilityDeps: SchedulerCapabilityDeps = {
  now: () => new Date(),
  autopilotEnabled: (tenant_id) =>
    getBoolSettingStrictResolved("cgo_autopilot_enabled", tenant_id),
  firstRunUsed: readFirstRunUsed,
  workerStopped: isWorkerCronStopped,
};

export async function resolveSchedulerCapability(
  tenant_id: string,
  deps: SchedulerCapabilityDeps = defaultSchedulerCapabilityDeps,
): Promise<SchedulerCapability> {
  const now = deps.now();
  const [autopilot_enabled, used] = await Promise.all([
    deps.autopilotEnabled(tenant_id),
    deps.firstRunUsed(tenant_id),
  ]);

  const scheduled_workers = GROWTH_SCHEDULED_WORKERS.map(
    ({ worker, cron }): ScheduledWorkerCapability => {
      const stopped = deps.workerStopped(worker);
      return {
        worker,
        allowlisted: !stopped,
        blocking_reason: stopped ? "worker_allowlist" : null,
        cron,
        timezone: "UTC",
        next_nominal_tick_at:
          nextLocalCronFire(cron, "UTC", now)?.toISOString() ?? null,
      };
    },
  );

  return {
    version: 1,
    observed_at: now.toISOString(),
    autopilot_enabled,
    scheduled_workers,
    event_driven: {
      paid_first_run: {
        trigger: "cgo_strategy_apply",
        used,
        eligibility: "not_evaluated",
        next_nominal_tick_at: null,
      },
      free_preview: {
        trigger: "cgo_strategy_apply",
        eligibility: "not_evaluated",
        next_nominal_tick_at: null,
      },
    },
  };
}
