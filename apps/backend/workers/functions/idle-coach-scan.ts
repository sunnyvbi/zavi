
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { getBoolSetting } from "@/services/settings";
import { isFleetHalted } from "@/services/agents/fleet-halt";
import { getAgentEffectiveStates } from "@/services/agents/visibility";
import { probeSetupCompleteness } from "@/services/agents/setup-schema";
import { rollupCronOutcomes } from "@/services/agents/cron-outcome";
import { missedDueBuckets } from "./cron-match";
import { isIdle, isEmpty, type CoachGateInput } from "@/services/agents/coach-detectors";
import { isCronStopped } from "@/services/agents/cron-stopped";
import { isWorkerCronStopped } from "@/services/agents/cron-stopped";

const MAX_COACH_TASKS_PER_TENANT = 5;
const COOLDOWN_HOURS = 24;

const CRON_GATED_UNWIRED = new Set<string>([]);
function cronGateBypassed(): boolean {
  return process.env.PRAXIS_DISABLE_CRON_GATE === "1";
}
function idleCoachEnabled(): boolean {
  return process.env.PRAXIS_IDLE_COACH_ENABLED !== "0";
}

type ScheduleRow = {
  tenant_id: string;
  agent_slug: string;
  cron_expression: string;
  enabled: boolean;
  last_fired_at: string | null;
};

export const idleCoachScanFn = inngest.createFunction(
  { id: "idle-coach-scan", concurrency: 1 },
  { cron: "0 14 * * *" },
  async ({ logger }) => {
    if (isWorkerCronStopped("idle-coach-scan")) {
      logger.info("idle-coach-scan: skipped — not on the scheduled-work allowlist");
      return { cron_stopped: true as const };
    }
    if (!idleCoachEnabled()) {
      logger?.info("idle-coach-scan: disabled (PRAXIS_IDLE_COACH_ENABLED=0)");
      return { skipped: "disabled" };
    }
    if (await isFleetHalted()) {
      logger?.info("idle-coach-scan: fleet halt active — scan skipped");
      return { skipped: "fleet_halt" };
    }

    const sb = serviceClient();
    const { data: schedules, error } = await sb
      .from("tenant_agent_schedules")
      .select("tenant_id, agent_slug, cron_expression, enabled, last_fired_at")
      .eq("enabled", true);
    if (error) {
      logger?.error(`idle-coach-scan: schedules read failed: ${error.message}`);
      return { error: error.message };
    }

    const now = new Date();
    const bypass = cronGateBypassed();

    const byTenant = new Map<string, ScheduleRow[]>();
    for (const s of (schedules ?? []) as ScheduleRow[]) {
      const arr = byTenant.get(s.tenant_id) ?? [];
      arr.push(s);
      byTenant.set(s.tenant_id, arr);
    }

    let created = 0;
    for (const [tenantId, rows] of byTenant) {
      const effective = await getAgentEffectiveStates(tenantId).catch(() => []);
      const hiddenSet = new Set(effective.filter((e) => e.effective_state === "hidden").map((e) => e.slug));
      const presentSet = new Set(effective.map((e) => e.slug));

      let tenantCreated = 0;
      for (const s of rows) {
        if (tenantCreated >= MAX_COACH_TASKS_PER_TENANT) break;
        if (!presentSet.has(s.agent_slug)) continue;

        const probe = await probeSetupCompleteness(tenantId, s.agent_slug).catch(() => null);
        const gate: CoachGateInput = {
          enabled: s.enabled,
          hidden: hiddenSet.has(s.agent_slug),
          cronGatedUnwired:
            (!bypass && CRON_GATED_UNWIRED.has(s.agent_slug)) || isCronStopped(s.agent_slug),
          missingRequiredConnectors: probe?.missing_required_connectors?.length ?? 1,
        };

        let detector: "idle" | "empty" | null = null;
        const lastFired = s.last_fired_at ? new Date(s.last_fired_at) : null;
        const missed = missedDueBuckets(s.cron_expression, lastFired, now);
        if (isIdle(gate, missed)) {
          detector = "idle";
        } else {
          const rollup = await rollupCronOutcomes(tenantId, s.agent_slug).catch(() => null);
          if (rollup && isEmpty(gate, rollup)) detector = "empty";
        }
        if (!detector) continue;

        const { data: taskId, error: rpcErr } = await sb.rpc("admin_task_create_with_cooldown", {
          p_tenant_id: tenantId,
          p_agent_slug: s.agent_slug,
          p_detector: detector,
          p_cooldown_hours: COOLDOWN_HOURS,
          p_priority: detector === "idle" ? 8 : 5,
        });
        if (rpcErr) {
          logger?.warn(`idle-coach-scan: create failed for ${tenantId}/${s.agent_slug}: ${rpcErr.message}`);
          continue;
        }
        if (taskId) {
          created += 1;
          tenantCreated += 1;
        }
      }
    }

    logger?.info(`idle-coach-scan: created ${created} coach tasks`);
    return { created };
  },
);
