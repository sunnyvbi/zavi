
import type { GoalTrajectory } from "@/lib/workspace/goalTrajectory";

export type HomeGoalStatus = "active" | "met" | "missed" | "paused";

export type HomeGoal = {
  id: string;
  objective: string;
  target_metric: string;
  target_value: number;
  baseline_value: number | null;
  current_value: number | null;
  due_date: string | null;
  status: HomeGoalStatus;
  priority: number;
  source: string;
  measurement_mode?: string | null;
  trajectory?: GoalTrajectory;
};

export type HomeStat = {
  label: string;
  value: string;
  status?: "measured" | "unavailable";
  unit?: "count" | "usd" | "ratio";
  direction?: "up" | "down" | "context";
  source: "metric" | "goal";
  metric_key?: string;
  target?: string;
  progress?: number;
  goal_id?: string;
};

const GOAL_STATUSES = new Set<HomeGoalStatus>([
  "active",
  "met",
  "missed",
  "paused",
]);

function obj(x: unknown): Record<string, unknown> {
  return x && typeof x === "object" && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : {};
}
function str(x: unknown, d = ""): string {
  return typeof x === "string" ? x : d;
}
function nstr(x: unknown): string | null {
  return typeof x === "string" ? x : null;
}
function numOrNull(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}
function num(x: unknown, d = 0): number {
  return typeof x === "number" && Number.isFinite(x) ? x : d;
}

function coerceGoal(x: unknown): HomeGoal {
  const o = obj(x);
  const status = str(o.status) as HomeGoalStatus;
  return {
    id: str(o.id),
    objective: str(o.objective),
    target_metric: str(o.target_metric),
    target_value: num(o.target_value),
    baseline_value: numOrNull(o.baseline_value),
    current_value: numOrNull(o.current_value),
    due_date: nstr(o.due_date),
    status: GOAL_STATUSES.has(status) ? status : "active",
    priority: num(o.priority),
    source: str(o.source),
    measurement_mode: nstr(o.measurement_mode),
    ...(o.trajectory && typeof o.trajectory === "object" ? { trajectory: o.trajectory as GoalTrajectory } : {}),
  };
}

function coerceStat(x: unknown): HomeStat {
  const o = obj(x);
  const progress = numOrNull(o.progress);
  const source = o.source === "goal" ? "goal" : "metric";
  const status = o.status === "unavailable" ? "unavailable" : "measured";
  return {
    label: str(o.label),
    value: str(o.value),
    status,
    ...(typeof o.unit === "string" ? { unit: o.unit as HomeStat["unit"] } : {}),
    ...(typeof o.direction === "string"
      ? { direction: o.direction as HomeStat["direction"] }
      : {}),
    source,
    ...(typeof o.metric_key === "string" ? { metric_key: o.metric_key } : {}),
    ...(typeof o.target === "string" ? { target: o.target } : {}),
    ...(progress != null ? { progress } : {}),
    ...(typeof o.goal_id === "string" ? { goal_id: o.goal_id } : {}),
  };
}

export function coerceGoals(raw: unknown): HomeGoal[] {
  const o = obj(raw);
  return Array.isArray(o.goals)
    ? o.goals.map(coerceGoal).filter((g) => g.id.length > 0)
    : [];
}

export function coerceStats(raw: unknown): HomeStat[] {
  const o = obj(raw);
  return Array.isArray(o.business_stats)
    ? o.business_stats.map(coerceStat).filter((s) => s.label.length > 0)
    : [];
}

export function goalProgress(g: HomeGoal): number | null {
  if (g.trajectory) return g.trajectory.progress;
  if (g.current_value == null) return null;
  const baseline = g.baseline_value ?? 0;
  const span = g.target_value - baseline;
  if (span === 0) return g.current_value >= g.target_value ? 1 : 0;
  const frac = (g.current_value - baseline) / span;
  if (!Number.isFinite(frac)) return null;
  return Math.max(0, Math.min(1, frac));
}
