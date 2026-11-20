
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { measureGoalMetric, type MeasureDeps } from "./goal-metric-resolver";

export async function refreshGoalNumbers(
  tenant_id: string,
  now: Date = new Date(),
  deps?: MeasureDeps,
): Promise<{ measured: number; failed: number }> {
  const out = { measured: 0, failed: 0 };
  try {
    const db = tenantClient(asTenantId(tenant_id));
    const { data, error } = await db
      .from("autopilot_goals")
      .select("id, target_metric, created_at, measure_source")
      .eq("tenant_id", tenant_id)
      .eq("status", "active")
      .eq("measurement_mode", "auto")
      .limit(20);
    if (error) throw new Error(error.message);
    for (const g of (data ?? []) as Array<{ id: string; target_metric: string; created_at: string | null; measure_source?: string | null }>) {
      try {
        const outcome = await measureGoalMetric({ tenant_id, target_metric: g.target_metric, goal_created_at: g.created_at, now, deps, measure_source: g.measure_source ?? null });
        if (!outcome.measured) continue;
        const { error: rpcErr } = await tenantRpc(asTenantId(tenant_id), "update_goal_progress", {
          p_goal_id: g.id,
          p_current_value: outcome.value,
        });
        if (rpcErr) throw new Error(rpcErr.message);
        const { error: stampErr } = await db
          .from("autopilot_goals")
          .update({ current_value_at: now.toISOString(), current_value_source: String(outcome.source).slice(0, 200) })
          .eq("id", g.id)
          .eq("tenant_id", tenant_id);
        if (stampErr) throw new Error(stampErr.message);
        out.measured++;
      } catch (e) {
        out.failed++;
        console.warn(`[refresh-goal-numbers] goal ${g.id} (tenant ${tenant_id}): ${(e as Error).message}`);
      }
    }
  } catch (e) {
    console.warn(`[refresh-goal-numbers] tenant ${tenant_id}: ${(e as Error).message}`);
  }
  return out;
}
