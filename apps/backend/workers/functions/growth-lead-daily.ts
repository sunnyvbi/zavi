
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { enqueueAgentRun } from "@/services/agents/runner";
import { getBoolSetting } from "@/services/settings";
import { isCronStopped } from "@/services/agents/cron-stopped";
import {
  buildGrowthFanInPayload,
  renderFanInBlock,
  renderBetOutcomesBlock,
  type MemoryNoteRow,
} from "@/services/growth/fan-in";

export { buildGrowthFanInPayload, renderFanInBlock, renderBetOutcomesBlock };
export type { MemoryNoteRow };

type TenantRow = {
  id: string;
  display_name: string | null;
};

export function growthDailyDedupeKey(tenantId: string, cronBucket: string): string {
  return `${tenantId}:growth-lead:${cronBucket}`;
}

export function utcDayBucket(now: Date = new Date()): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
}

export async function fanInOneTenant(
  tenant: TenantRow,
  cronBucket: string,
): Promise<{
  enqueued: boolean;
  reason: string;
  run_id?: string;
}> {
  if (isCronStopped("growth-lead")) {
    return { enqueued: false, reason: "cron_stopped" };
  }

  const built = await buildGrowthFanInPayload(tenant.id);
  const fanInBlock = (built.memory as { growth_fan_in: string }).growth_fan_in;
  const notes = built.fan_in_note_ids as string[];

  try {
    const { run_id } = await enqueueAgentRun({
      tenant_id: tenant.id,
      agent_slug: "growth-lead",
      trigger: "cron",
      cron_dedupe_key: growthDailyDedupeKey(tenant.id, cronBucket),
      payload: {
        memory: { growth_fan_in: fanInBlock },
        fan_in_note_ids: notes,
      },
    });
    if (!run_id) {
      return { enqueued: false, reason: "deduped_same_bucket" };
    }
    return { enqueued: true, reason: "ok", run_id };
  } catch (e) {
    return {
      enqueued: false,
      reason: `enqueueAgentRun failed: ${(e as Error).message}`,
    };
  }
}

export const growthOrchestratorDailyFn = inngest.createFunction(
  { id: "growth-lead-daily" },
  { cron: "0 6 * * *" },
  async ({ step, logger }) => {
    if (isCronStopped("growth-lead")) {
      logger.info("growth-lead-daily: skipped — growth-lead cron stopped fleet-wide");
      return {
        scanned: 0,
        enqueued: 0,
        skipped_deduped: 0,
        skipped_autopilot_off: 0,
        skipped_killed_or_disabled: 0,
        skipped_error: 0,
        enqueued_runs: [] as Array<{ tenant_id: string; run_id: string }>,
        cron_stopped: true,
      };
    }

    const { tenants: result, cronBucket, skipped_scheduled } = await step.run(
      "scan-tenants",
      async () => {
        const svc = serviceClient();
        const { data, error } = await svc.from("tenants").select("id, display_name");
        if (error) throw new Error(`tenant scan failed: ${error.message}`);

        const covered = new Set<string>();
        const { data: sched, error: schedErr } = await svc
          .from("tenant_agent_schedules")
          .select("tenant_id")
          .eq("agent_slug", "growth-lead")
          .eq("enabled", true);
        if (schedErr) {
          console.warn(
            `[growth-lead-daily] schedule-coverage read failed (falling back to fire-for-all): ${schedErr.message}`,
          );
        } else {
          for (const r of (sched ?? []) as Array<{ tenant_id: string }>) covered.add(r.tenant_id);
        }

        const all = (data ?? []) as TenantRow[];
        return {
          tenants: all.filter((t) => !covered.has(t.id)),
          skipped_scheduled: all.filter((t) => covered.has(t.id)).length,
          cronBucket: utcDayBucket(),
        };
      },
    );

    if (skipped_scheduled > 0) {
      logger.info(
        `growth-lead-daily: ${skipped_scheduled} tenant(s) skipped — their own schedule row drives growth-lead`,
      );
    }

    let enqueued = 0;
    let skipped_deduped = 0;
    let skipped_killed_or_disabled = 0;
    let skipped_autopilot_off = 0;
    let skipped_error = 0;
    const enqueued_runs: Array<{ tenant_id: string; run_id: string }> = [];

    for (const tenant of result) {
      try {
        const outcome = await fanInOneTenant(tenant, cronBucket);
        if (outcome.enqueued && outcome.run_id) {
          enqueued += 1;
          enqueued_runs.push({ tenant_id: tenant.id, run_id: outcome.run_id });
        } else if (outcome.reason === "deduped_same_bucket") {
          skipped_deduped += 1;
        } else if (
          outcome.reason.includes("kill_switch") ||
          outcome.reason.includes("disabled") ||
          outcome.reason.includes("manual_only")
        ) {
          skipped_killed_or_disabled += 1;
        } else {
          skipped_error += 1;
          logger.warn(
            `[growth-lead-daily] tenant ${tenant.id} skipped: ${outcome.reason}`,
          );
        }
      } catch (e) {
        skipped_error += 1;
        logger.warn(
          `[growth-lead-daily] tenant ${tenant.id} threw: ${(e as Error).message}`,
        );
      }
    }

    return {
      scanned: result.length,
      enqueued,
      skipped_deduped,
      skipped_autopilot_off,
      skipped_killed_or_disabled,
      skipped_error,
      enqueued_runs,
    };
  },
);
