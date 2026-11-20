
import {
  METRIC_REGISTRY,
  classifyGoalMetricKey,
  type MetricDef,
} from "@/services/analytics/metric-registry";
import {
  readMetricHistory,
  type MetricSnapshotRow,
} from "@/services/analytics/record-metric-snapshot";
import { detectAnomaly, isBadMove, type AnomalyPoint } from "@/services/analytics/anomaly";
import { localDateOf } from "@/services/analytics/metric-time";

export const TREND_WINDOW_KIND = "rolling_7d";
export const TREND_HISTORY_LIMIT = 120;

export type TrendVerdict =
  | {
      off_track: true;
      reason: "anomaly_drop" | "anomaly_rise";
      pct: number;
      z: number;
    }
  | {
      off_track: false;
      reason:
        | "insufficient_history"
        | "context_metric"
        | "within_threshold"
        | "good_direction"
        | "unmapped_metric"
        | "trend_eval_failed";
    };

export function formatTrendNote(v: Extract<TrendVerdict, { off_track: true }>): string {
  const rounded = Math.round(v.pct);
  return `trend ${rounded >= 0 ? "+" : ""}${rounded}% vs its 8-week average`;
}

export function snapshotsToPoints(history: MetricSnapshotRow[], tz = "UTC"): AnomalyPoint[] {
  const usable = history
    .filter(
      (r) =>
        r.value !== null && Number.isFinite(r.value) &&
        Number.isFinite(Date.parse(r.window_end)),
    )
    .sort((a, b) => Date.parse(b.window_end) - Date.parse(a.window_end));
  const latest = usable[0];
  if (!latest) return [];
  const byDay = new Map<string, number>();
  for (const r of usable) {
    if (r.window_kind !== latest.window_kind) continue;
    const day = localDateOf(new Date(r.window_end), tz);
    if (!byDay.has(day)) byDay.set(day, r.value as number);
  }
  return [...byDay.entries()].map(([date, value]) => ({ date, value }));
}

export function isTrendOffTrack(
  history: MetricSnapshotRow[],
  def: Pick<MetricDef, "direction"> & Partial<Pick<MetricDef, "unit">>,
  tz = "UTC",
): TrendVerdict {
  if (def.direction === "context") {
    return { off_track: false, reason: "context_metric" };
  }
  const v = detectAnomaly(snapshotsToPoints(history, tz), { kind: "other", isCount: def.unit === "count" });
  if (!v.anomaly) {
    return { off_track: false, reason: v.reason === "within_normal" ? "within_threshold" : "insufficient_history" };
  }
  if (!isBadMove(def.direction, v.direction)) return { off_track: false, reason: "good_direction" };
  const pct = v.baseline_mean !== 0 ? ((v.value - v.baseline_mean) / Math.abs(v.baseline_mean)) * 100 : 0;
  return { off_track: true, reason: v.direction === "down" ? "anomaly_drop" : "anomaly_rise", pct, z: v.z };
}

export type TrendDeps = {
  classifyGoalMetricKey: (target_metric: string) => string | null;
  getMetricDef: (metric_key: string) => MetricDef | undefined;
  readMetricHistory: (
    tenant_id: string,
    metric_key: string,
    opts?: { window_kind?: MetricSnapshotRow["window_kind"]; limit?: number },
  ) => Promise<MetricSnapshotRow[]>;
  resolveTimezone?: (tenant_id: string) => Promise<string>;
};

export const realTrendDeps: TrendDeps = {
  classifyGoalMetricKey,
  getMetricDef: (metric_key) => METRIC_REGISTRY[metric_key],
  readMetricHistory,
  resolveTimezone: async (tenant_id) => {
    const { resolveReportingTimezone } = await import("@/services/analytics/tenant-timezone");
    return (await resolveReportingTimezone(tenant_id)).tz;
  },
};

export async function evaluateTrendForGoal(
  tenant_id: string,
  target_metric: string,
  deps: TrendDeps = realTrendDeps,
): Promise<TrendVerdict> {
  try {
    const metric_key = deps.classifyGoalMetricKey(target_metric);
    if (!metric_key) return { off_track: false, reason: "unmapped_metric" };
    const def = deps.getMetricDef(metric_key);
    if (!def) return { off_track: false, reason: "unmapped_metric" };
    if (def.direction === "context") {
      return { off_track: false, reason: "context_metric" };
    }
    const history = await deps.readMetricHistory(tenant_id, metric_key, {
      window_kind: TREND_WINDOW_KIND,
      limit: TREND_HISTORY_LIMIT,
    });
    const tz = deps.resolveTimezone ? await deps.resolveTimezone(tenant_id).catch(() => "UTC") : "UTC";
    return isTrendOffTrack(history ?? [], def, tz);
  } catch {
    return { off_track: false, reason: "trend_eval_failed" };
  }
}
