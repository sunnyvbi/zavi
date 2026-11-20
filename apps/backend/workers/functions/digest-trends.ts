
import {
  METRIC_REGISTRY,
  classifyGoalMetricKey,
  type MetricDef,
} from "@/services/analytics/metric-registry";
import {
  readMetricHistory,
  type MetricSnapshotRow,
} from "@/services/analytics/record-metric-snapshot";
import { labelLine } from "./digest-yesterday";

export type TrendHistories = Record<string, MetricSnapshotRow[]>;

const DAY_MS = 24 * 60 * 60 * 1000;
const WOW_TARGET_DAYS = 7;
const WOW_MIN_GAP_DAYS = 4;
const WOW_MAX_GAP_DAYS = 14;
const HISTORY_FETCH_LIMIT = 30;

export type WoWPair = {
  latest: MetricSnapshotRow;
  baseline: MetricSnapshotRow;
  pct: number | null;
};

function isComparable(r: MetricSnapshotRow): boolean {
  return (
    r.status === "measured" &&
    typeof r.value === "number" &&
    Number.isFinite(r.value) &&
    typeof r.window_end === "string" &&
    Number.isFinite(Date.parse(r.window_end))
  );
}

export function selectWoWPair(rows: readonly MetricSnapshotRow[]): WoWPair | null {
  const usable = rows.filter(isComparable);
  if (usable.length < 2) return null;

  const sorted = [...usable].sort(
    (a, b) => Date.parse(b.window_end) - Date.parse(a.window_end),
  );
  const latest = sorted[0];
  const latestEnd = Date.parse(latest.window_end);
  const target = latestEnd - WOW_TARGET_DAYS * DAY_MS;

  let baseline: MetricSnapshotRow | null = null;
  let bestDist = Infinity;
  for (const r of sorted.slice(1)) {
    if (r.window_kind !== latest.window_kind) continue;
    const end = Date.parse(r.window_end);
    const gapDays = (latestEnd - end) / DAY_MS;
    if (gapDays < WOW_MIN_GAP_DAYS || gapDays > WOW_MAX_GAP_DAYS) continue;
    const dist = Math.abs(end - target);
    if (dist < bestDist || (dist === bestDist && baseline !== null)) {
      baseline = r;
      bestDist = dist;
    }
  }
  if (!baseline || baseline.value == null || latest.value == null) return null;

  const pct =
    baseline.value === 0
      ? null
      : Math.round(((latest.value - baseline.value) / Math.abs(baseline.value)) * 100);
  return { latest, baseline, pct };
}

function fmtValue(v: number, unit: string): string {
  const rounded = Math.abs(v - Math.round(v)) < 1e-9 ? String(Math.round(v)) : v.toFixed(2);
  if (unit === "usd" || unit === "$") return `$${rounded}`;
  if (unit === "percent" || unit === "%") return `${rounded}%`;
  return rounded;
}

function windowTag(window_kind: string): string {
  if (/7d/i.test(window_kind)) return "7d";
  if (/week/i.test(window_kind)) return "7d";
  if (/point|snapshot|instant/i.test(window_kind)) return "now";
  return window_kind;
}

export function changePhrase(
  direction: MetricDef["direction"],
  pct: number | null,
): string {
  if (pct === null) return "";
  if (pct === 0) return "(no change)";
  const abs = Math.abs(pct);
  if (direction === "context") return pct > 0 ? `(+${pct}%)` : `(-${abs}%)`;
  if (direction === "up") return pct > 0 ? `(+${pct}%)` : `(⚠ down ${abs}%)`;
  return pct < 0 ? `(down ${abs}%, improving)` : `(⚠ up ${pct}%)`;
}

export function buildTrendLines(args: { histories: TrendHistories }): string[] {
  const lines: string[] = [];
  for (const [key, def] of Object.entries(METRIC_REGISTRY)) {
    const rows = args.histories[key] ?? [];
    if (rows.length === 0) continue;

    const tag = windowTag(def.window_kind);

    const newest = [...rows].sort(
      (a, b) => Date.parse(b.window_end) - Date.parse(a.window_end),
    )[0];
    if (newest && newest.status === "unavailable") {
      const reason = newest.source
        ? `${newest.source} unavailable`
        : "source unavailable";
      lines.push(labelLine(`${def.label} (${tag}): no reading (${reason})`, "observed"));
      continue;
    }

    const pair = selectWoWPair(rows);
    if (!pair) continue;

    const latestV = fmtValue(pair.latest.value as number, def.unit);
    const baseV = fmtValue(pair.baseline.value as number, def.unit);
    const phrase = changePhrase(def.direction, pair.pct);
    const tail = phrase ? ` ${phrase}` : "";
    lines.push(
      labelLine(`${def.label} (${tag}): ${latestV} vs ${baseV} a week earlier${tail}`, "observed"),
    );
  }
  return lines;
}

export function metricKeyForGoalMetric(target_metric: string): string | null {
  const exact = target_metric.trim().toLowerCase();
  if (METRIC_REGISTRY[exact]) return exact;
  return classifyGoalMetricKey(target_metric);
}

export function buildGoalTrendLine(
  metric_key: string,
  rows: readonly MetricSnapshotRow[],
): string | null {
  const def = METRIC_REGISTRY[metric_key];
  if (!def) return null;
  const pair = selectWoWPair(rows);
  if (!pair) return null;
  const latestV = fmtValue(pair.latest.value as number, def.unit);
  const baseV = fmtValue(pair.baseline.value as number, def.unit);
  const pctPart =
    pair.pct === null ? "" : ` (${pair.pct > 0 ? `+${pair.pct}` : pair.pct}%)`;
  return `trend: ${latestV} now, ${baseV} a week ago${pctPart}`;
}

export async function fetchTrendHistories(tenant_id: string): Promise<TrendHistories> {
  const out: TrendHistories = {};
  for (const [key, def] of Object.entries(METRIC_REGISTRY)) {
    try {
      const rows = await readMetricHistory(tenant_id, key, {
        window_kind: def.window_kind,
        limit: HISTORY_FETCH_LIMIT,
      });
      if (rows.length > 0) out[key] = rows;
    } catch {
    }
  }
  return out;
}

export async function fetchGoalTrendLines(
  tenant_id: string,
  goals: ReadonlyArray<{ id: string; target_metric: string }>,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const historyByKey = new Map<string, MetricSnapshotRow[]>();
  for (const g of goals) {
    try {
      const key = metricKeyForGoalMetric(g.target_metric);
      if (!key) continue;
      if (!historyByKey.has(key)) {
        historyByKey.set(
          key,
          await readMetricHistory(tenant_id, key, {
            window_kind: METRIC_REGISTRY[key].window_kind,
            limit: HISTORY_FETCH_LIMIT,
          }),
        );
      }
      const line = buildGoalTrendLine(key, historyByKey.get(key) ?? []);
      if (line) out[g.id] = line;
    } catch {
    }
  }
  return out;
}
