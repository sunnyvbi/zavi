
import { METRIC_REGISTRY, classifyGoalMetricKey } from "@/services/analytics/metric-registry";

export const GOAL_HISTORY_MAX_POINTS = 90;

export const SNAPSHOT_SOURCE_TO_CONNECTOR: Record<string, string> = {
  stripe: "stripe",
  stripe_mrr: "stripe",
  meta_ads: "meta_ads",
  google_ads: "google_ads",
  operator_db: "operator_db",
};

export type GoalHistoryGoal = { id: string; target_metric: unknown; measurement_mode: unknown };

export type GoalHistory = {
  metric_key: string | null;
  label?: string | null;
  source?: string;
  window_kind?: string;
  unit?: string | null;
  direction?: string | null;
  points: Array<{ at: string; value: number }>;
  last_measured_at: string | null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SnapshotDb = { from: (table: string) => { select: (cols: string) => any } };

type Row = { at: string; value: number; created_at: string; source: string };

export async function readGoalHistory(
  db: SnapshotDb,
  tenant_id: string,
  goal: GoalHistoryGoal,
  maxPoints = GOAL_HISTORY_MAX_POINTS,
): Promise<GoalHistory> {
  const metricKey = typeof goal.target_metric === "string" ? classifyGoalMetricKey(goal.target_metric) : null;
  const def = metricKey ? METRIC_REGISTRY[metricKey] : undefined;

  const read = async (key: string, windowKind?: string): Promise<Row[]> => {
    let q = db
      .from("tenant_metric_snapshots")
      .select("value, window_end, created_at, source")
      .eq("tenant_id", tenant_id)
      .eq("metric_key", key)
      .eq("status", "measured");
    if (windowKind) q = q.eq("window_kind", windowKind);
    const { data, error } = await q.order("window_end", { ascending: false }).limit(maxPoints);
    if (error) throw new Error(error.message);
    return ((data ?? []) as Array<Record<string, unknown>>)
      .map((r) => ({ at: String(r.window_end), value: r.value === null ? NaN : Number(r.value), created_at: String(r.created_at), source: String(r.source) }))
      .filter((r) => Number.isFinite(r.value));
  };

  const [typed, metric] = await Promise.all([read(`goal:${goal.id}`), def ? read(def.key, def.window_kind) : Promise.resolve([] as Row[])]);
  let own = typed;
  if (typed.length > 0) {
    const { data, error } = await db
      .from("autopilot_goal_changes")
      .select("created_at")
      .eq("tenant_id", tenant_id)
      .eq("goal_id", goal.id)
      .eq("op", "update")
      .not("changed_fields->target_metric", "is", null)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);
    const changedAt = Date.parse(String(((data ?? []) as Array<{ created_at?: unknown }>)[0]?.created_at ?? ""));
    if (Number.isFinite(changedAt)) {
      own = typed.filter((r) => {
        const stored = Date.parse(r.created_at);
        return (Number.isFinite(stored) ? stored : Date.parse(r.at)) > changedAt;
      });
    }
  }
  const auto = goal.measurement_mode === "auto";
  const useMetric = !!def && metric.length > 0 && (auto || own.length === 0);
  const rows = useMetric ? metric : own;
  if (rows.length === 0) return { metric_key: def?.key ?? null, points: [], last_measured_at: null };
  return {
    metric_key: useMetric && def ? def.key : `goal:${goal.id}`,
    label: useMetric && def ? def.label : null,
    source: useMetric && def ? (SNAPSHOT_SOURCE_TO_CONNECTOR[rows[0].source] ?? def.source) : "founder_reported",
    window_kind: useMetric && def ? def.window_kind : "point",
    unit: useMetric && def ? def.unit : null,
    direction: useMetric && def ? def.direction : null,
    points: rows.map(({ at, value }) => ({ at, value })).reverse(),
    last_measured_at: rows[0].created_at,
  };
}
