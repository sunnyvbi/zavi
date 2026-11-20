
import { asTenantId, tenantRpc } from "@/services/tenant-client";

export type GoalActor =
  | { source: "cgo"; run_id: string; why: string }
  | { source: "founder"; user_id: string; why?: string | null }
  | { source: "staff"; user_id: string; why?: string | null }
  | { source: "system"; why?: string | null };

export type GoalWrite = {
  op: "insert" | "update" | "delete";
  goal_id?: string | null;
  values?: Record<string, unknown>;
  expect?: Record<string, unknown>;
  status_not_in?: string[];
  actor: GoalActor;
};

export type GoalWriteResult = { status: "written"; id: string } | { status: "not_matched" } | { status: "error"; error: string };

export async function writeAutopilotGoal(tenant_id: string, w: GoalWrite): Promise<GoalWriteResult> {
  try {
    const { data, error } = await tenantRpc(asTenantId(tenant_id), "write_autopilot_goal", {
      p_op: w.op,
      p_goal_id: w.goal_id ?? null,
      p_values: w.values ?? null,
      p_expect: w.expect ?? null,
      p_status_not_in: w.status_not_in ?? null,
      p_actor_source: w.actor.source,
      p_actor_user_id: w.actor.source === "founder" || w.actor.source === "staff" ? w.actor.user_id : null,
      p_run_id: w.actor.source === "cgo" ? w.actor.run_id : null,
      p_why: w.actor.why ?? null,
    });
    if (error) return { status: "error", error: error.message };
    const ans = (data ?? {}) as { status?: unknown; id?: unknown };
    if (ans.status === "written" && typeof ans.id === "string") return { status: "written", id: ans.id };
    if (ans.status === "not_matched") return { status: "not_matched" };
    return { status: "error", error: "write_autopilot_goal: answer not understood" };
  } catch (e) {
    return { status: "error", error: (e as Error).message };
  }
}
