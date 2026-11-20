
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { METRIC_REGISTRY, classifyGoalMetricKey } from "@/services/analytics/metric-registry";
import { writeAutopilotGoal, type GoalActor } from "./goal-write";
import { goalKind, proposedPeriodStart, valueKindRefusal, type TrajectoryGoal } from "./goal-trajectory";
import { goalRev } from "./goal-owner";
import type { OnYes, QuestionAsk } from "./cgo-questions";

type BasisGoal = TrajectoryGoal & { id: string; objective: string; target_metric: string; due_date: string | null };
type BasisOnYes = Extract<OnYes, { kind: "goal_basis" }>;

function fmt(n: number): string {
  const [whole, frac] = String(Number(n)).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac ? `${grouped}.${frac}` : grouped;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function shortDay(day: string): string {
  const [, m, d] = day.slice(0, 10).split("-").map(Number);
  return `${MONTHS[(m ?? 1) - 1]} ${d}`;
}

const bare = (t: string) => t.replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "");

function directionOf(metric: string): "up" | "down" | "context" | null {
  const key = classifyGoalMetricKey(metric);
  return key ? (METRIC_REGISTRY[key]?.direction ?? null) : null;
}

export function basisAsk(g: BasisGoal, today: string, rev: string): QuestionAsk | null {
  if (goalKind(g) !== "ambiguous" || g.current_value == null || g.baseline_value == null) return null;
  const start = proposedPeriodStart(g, today);
  if (!start) return null;
  const refusal = valueKindRefusal({
    value_kind: "period_total",
    value_period_start: start,
    target_value: g.target_value == null ? null : Number(g.target_value),
    baseline_value: Number(g.baseline_value),
    measurement_mode: g.measurement_mode,
    due_date: g.due_date,
    direction: directionOf(g.target_metric),
    target_metric: g.target_metric,
  });
  if (refusal) return null;
  const thisMonth = start.endsWith("-01") && g.due_date != null && g.due_date.slice(0, 7) === start.slice(0, 7);
  const span = thisMonth ? "this month's total so far" : `the total since ${shortDay(start)}`;
  const ask = `Is the ${fmt(Number(g.current_value))} on "${bare(g.objective)}" ${span}, counted from 0 since ${shortDay(start)}, rather than a running number that started at ${fmt(Number(g.baseline_value))}?`;
  return {
    required: true,
    topic_key: `basis:${g.id}`,
    ask,
    default_action: null,
    why: "Until I know, I can't say whether this goal is on pace.",
    on_yes: { kind: "goal_basis", goal_id: g.id, goal_rev: rev, value_period_start: start, why: "the founder said how the number counts" },
  };
}

export type BasisApplied = { line: string; applied_at: string };

export async function applyGoalBasis(
  tenant_id: string,
  a: BasisOnYes,
  answer: "yes" | "no",
  actor: GoalActor,
  now: Date = new Date(),
): Promise<BasisApplied | null> {
  if (a.undone_at) return null;
  const db = tenantClient(asTenantId(tenant_id));
  const { data, error } = await db
    .from("autopilot_goals")
    .select("id, objective, target_metric, target_value, baseline_value, measurement_mode, due_date, status, value_kind")
    .eq("tenant_id", tenant_id)
    .eq("id", a.goal_id)
    .maybeSingle<{ id: string; objective: string; target_metric: string; target_value: number | string | null; baseline_value: number | string | null; measurement_mode: string | null; due_date: string | null; status: string; value_kind: string | null }>();
  if (error) throw new Error(`goal-basis: reading the goal failed: ${error.message}`);
  if (!data || data.status !== "active" || data.value_kind != null) return null;
  const target = data.target_value == null ? null : Number(data.target_value);
  if (a.goal_rev && goalRev({ objective: data.objective, target_metric: data.target_metric, target_value: target, due_date: data.due_date }) !== a.goal_rev) return null;
  const value_kind = answer === "yes" ? "period_total" : "gauge";
  const value_period_start = answer === "yes" ? a.value_period_start : null;
  const base = data.baseline_value == null ? null : Number(data.baseline_value);
  const refusal = valueKindRefusal({
    value_kind,
    value_period_start,
    target_value: target,
    baseline_value: base,
    measurement_mode: data.measurement_mode,
    due_date: data.due_date,
    direction: directionOf(data.target_metric),
    target_metric: data.target_metric,
  });
  if (refusal) {
    console.warn(`[goal-basis] answer for goal ${a.goal_id} not stored: ${refusal}`);
    return null;
  }
  const applied_at = now.toISOString();
  const w = await writeAutopilotGoal(tenant_id, {
    op: "update",
    goal_id: a.goal_id,
    values: { value_kind, value_period_start, updated_at: applied_at },
    expect: { status: "active", value_kind: null, objective: data.objective, target_metric: data.target_metric, target_value: data.target_value, due_date: data.due_date },
    actor,
  });
  if (w.status === "error") throw new Error(`goal-basis: storing the answer failed: ${w.error}`);
  if (w.status !== "written") return null;
  const name = bare(data.objective);
  const line =
    answer === "yes"
      ? `Goal "${name}": counting its number as the total since ${shortDay(a.value_period_start)}, so its pace runs from 0 to ${target == null ? "the target" : fmt(target)}.`
      : `Goal "${name}": counting its number as a running number from ${base == null ? "where it started" : fmt(base)}.`;
  return { line, applied_at };
}

export async function undoGoalBasis(tenant_id: string, a: BasisOnYes, answer: "yes" | "no"): Promise<string | null> {
  if (!a.applied_at || a.undone_at) return null;
  const w = await writeAutopilotGoal(tenant_id, {
    op: "update",
    goal_id: a.goal_id,
    values: { value_kind: null, value_period_start: null, updated_at: new Date().toISOString() },
    expect: {
      value_kind: answer === "yes" ? "period_total" : "gauge",
      value_period_start: answer === "yes" ? a.value_period_start : null,
      updated_at: a.applied_at,
    },
    actor: { source: "system", why: "Undo from the founder's email reply" },
  });
  if (w.status === "error") throw new Error(`goal-basis: undo failed: ${w.error}`);
  return w.status === "written" ? "That goal is back to not saying how its number counts." : null;
}
