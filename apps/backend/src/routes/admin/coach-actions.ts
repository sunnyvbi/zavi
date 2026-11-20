
import type { Request, Response } from "express";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";
import { GROWTH_FUNCTIONS } from "@/services/agents/growth-coverage";
import { setGoalMeasurementMode } from "@/services/autopilot/goal-measurement";
import { writeAutopilotGoal } from "@/services/growth/goal-write";
import {
  extractPrimaryGoalId,
  selectAgentProposedRunIds,
  type ConductorRunRef,
} from "@/services/agents/coach-precedence";

const Body = z.object({
  function: z.enum(GROWTH_FUNCTIONS as unknown as [string, ...string[]]),
  objective: z.string().min(1).max(2000),
  target_metric: z.string().min(1).max(200),
  target_value: z.number(),
  baseline_value: z.number().optional(),
  due_date: z.string().date().optional(),
  priority: z.number().int().min(1).max(100).optional(),
  coach_task_id: z.string().uuid().optional(),
});

export async function staffCoachSetGoal(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const tenantId = req.params.tenant_id;
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "bad_request", message: parsed.error.message } });
    return;
  }
  const b = parsed.data;
  const sb = serviceClient();

  const { data: tenant } = await sb.from("tenants").select("id").eq("id", tenantId).maybeSingle();
  if (!tenant) {
    res.status(404).json({ error: { code: "tenant_not_found", message: tenantId } });
    return;
  }

  const actor = { source: "staff" as const, user_id: staff.user_id, why: "Set from the staff coach console" };
  const created = await writeAutopilotGoal(tenantId, {
    op: "insert",
    values: {
      objective: b.objective,
      target_metric: b.target_metric,
      target_value: b.target_value,
      baseline_value: b.baseline_value ?? null,
      current_value: b.baseline_value ?? null,
      due_date: b.due_date ?? null,
      priority: b.priority ?? 70,
      source: "founder",
    },
    actor,
  });
  if (created.status !== "written") {
    res.status(500).json({ error: { code: "set_goal_failed", message: created.status === "error" ? created.error : "no goal id returned" } });
    return;
  }
  const goalId = created.id;

  if (typeof goalId === "string") {
    await setGoalMeasurementMode(tenantId, goalId, b.target_metric, actor);
  }

  const { data: rejected } = await sb
    .from("decisions")
    .update({ status: "rejected" })
    .eq("tenant_id", tenantId)
    .eq("decision_class", "autopilot.daily-plan")
    .eq("status", "proposed")
    .select("id");
  const rejectedIds = (rejected ?? []).map((r) => (r as { id: string }).id);

  const { data: activeRuns } = await sb
    .from("conductor_runs")
    .select("id, goal_graph")
    .eq("tenant_id", tenantId)
    .eq("kind", "company_goal")
    .eq("status", "active");
  const refs: ConductorRunRef[] = (activeRuns ?? []).map((r) => ({
    id: (r as { id: string }).id,
    goalId: extractPrimaryGoalId((r as { goal_graph: unknown }).goal_graph),
  }));
  const goalIds = [...new Set(refs.map((r) => r.goalId).filter((g): g is string => !!g))];
  const sourceById = new Map<string, string>();
  if (goalIds.length > 0) {
    const { data: goals } = await sb
      .from("autopilot_goals")
      .select("id, source")
      .eq("tenant_id", tenantId)
      .in("id", goalIds);
    for (const g of goals ?? []) sourceById.set((g as { id: string }).id, (g as { source: string }).source);
  }
  const toCancel = selectAgentProposedRunIds(refs, sourceById);
  const cancelledIds: string[] = [];
  for (const runId of toCancel) {
    const { error: cErr } = await sb.rpc("cancel_conductor_run", {
      p_tenant_id: tenantId,
      p_conductor_run_id: runId,
      p_reason: "coach_precedence",
    });
    if (!cErr) cancelledIds.push(runId);
  }

  await sb.rpc("admin_action_log_append", {
    p_staff_email: staff.email,
    p_tenant_id: tenantId,
    p_task_id: b.coach_task_id ?? null,
    p_action: "set_goal",
    p_target: b.function,
    p_before: null,
    p_after: { goal_id: goalId, priority: b.priority ?? 70, rejected: rejectedIds, cancelled: cancelledIds },
    p_on_behalf: true,
  });

  if (b.coach_task_id) {
    await sb.rpc("admin_task_resolve", {
      p_task_id: b.coach_task_id,
      p_resolution: { via: "set_goal", goal_id: goalId, function: b.function },
    });
  }

  res.json({
    ok: true,
    goal_id: goalId,
    function: b.function,
    rejected_decisions: rejectedIds.length,
    cancelled_runs: cancelledIds.length,
  });
}
