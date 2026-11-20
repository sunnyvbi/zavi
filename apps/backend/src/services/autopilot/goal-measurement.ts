
import { serviceClient } from "@/services/supabase";
import { writeAutopilotGoal, type GoalActor } from "@/services/growth/goal-write";
import { classifyMetricMode } from "./goal-metric-vocab";

export const FOUNDER_ENTERED_SOURCE = "entered by the founder";

export type ActiveGoal = {
  objective: string;
  target_metric: string | null;
};

export async function getActiveGoals(tenantId: string): Promise<ActiveGoal[]> {
  try {
    const { data, error } = await serviceClient()
      .from("autopilot_goals")
      .select("objective, target_metric")
      .eq("tenant_id", tenantId)
      .eq("status", "active")
      .order("priority", { ascending: false })
      .limit(20);
    if (error) return [];
    return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
      objective: typeof r.objective === "string" ? r.objective : "",
      target_metric:
        typeof r.target_metric === "string" ? r.target_metric : null,
    }));
  } catch {
    return [];
  }
}

export async function writeCreatedGoalMeasurement(
  tenantId: string,
  goalId: string,
  fields: { measurement_mode: "auto" | "manual_reported"; current_value?: number; current_value_at?: string; current_value_source?: string },
  actor: GoalActor,
): Promise<string | null> {
  const w = await writeAutopilotGoal(tenantId, { op: "update", goal_id: goalId, values: fields, actor });
  if (w.status === "error") return w.error || "update failed";
  return w.status === "written" ? null : "no goal with that id for this tenant";
}

export async function setGoalMeasurementMode(
  tenantId: string,
  goalId: string,
  targetMetric: string,
  actor: GoalActor,
): Promise<void> {
  try {
    const mode = classifyMetricMode(targetMetric);
    const w = await writeAutopilotGoal(tenantId, { op: "update", goal_id: goalId, values: { measurement_mode: mode }, actor });
    if (w.status === "error") {
      console.warn(
        `[goal-measurement] measurement_mode update failed for ${goalId}: ${w.error}`,
      );
    }
  } catch (e) {
    console.warn(
      `[goal-measurement] measurement_mode update threw for ${goalId}: ${(e as Error).message}`,
    );
  }
}
