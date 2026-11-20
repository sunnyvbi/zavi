
import { addDays, daysBetween, type LocalDate } from "@/services/analytics/metric-time";

export const ANOMALY_Z = 2;
export const ANOMALY_TRAILING_WEEKS = 8;
export const MIN_PRIOR_POINTS = 6;
export const RELATIVE_SD_FLOOR = 0.05;

export type SeriesKind = "daily" | "other";

export type AnomalyPoint = { date: LocalDate; value: number | null };

export type AnomalyVerdict =
  | {
      anomaly: true;
      direction: "up" | "down";
      date: LocalDate;
      value: number;
      z: number;
      weekday_z: number | null;
      typical: number;
      baseline_mean: number;
      prior_points: number;
    }
  | {
      anomaly: false;
      reason: "not_enough_history" | "no_value" | "flat_history" | "within_normal" | "weekday_normal";
      z?: number;
      prior_points?: number;
    };

type Stats = { mean: number; sd: number; n: number };

function stats(values: number[]): Stats {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? values.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1) : 0;
  return { mean, sd: Math.sqrt(variance), n };
}

export function effectiveSd(s: Stats, isCount: boolean): number {
  const floor = isCount ? Math.sqrt(Math.max(s.mean, 1)) : RELATIVE_SD_FLOOR * Math.abs(s.mean);
  return Math.max(s.sd, floor);
}

function zOf(value: number, s: Stats, isCount: boolean): number | null {
  const sd = effectiveSd(s, isCount);
  if (!(sd > 0)) return null;
  return (value - s.mean) / sd;
}

function usable(p: AnomalyPoint): p is { date: LocalDate; value: number } {
  return p.value !== null && Number.isFinite(p.value);
}

export function detectAnomaly(
  series: AnomalyPoint[],
  opts: { kind: SeriesKind; isCount: boolean; date?: LocalDate },
): AnomalyVerdict {
  const points = series.filter(usable);
  const date = opts.date ?? points.reduce<LocalDate | null>((m, p) => (m === null || p.date > m ? p.date : m), null);
  if (!date) return { anomaly: false, reason: "no_value" };
  const current = points.find((p) => p.date === date);
  if (!current) return { anomaly: false, reason: "no_value" };

  const since = addDays(date, -7 * ANOMALY_TRAILING_WEEKS);
  const prior = points.filter((p) => p.date >= since && p.date < date);
  if (prior.length < MIN_PRIOR_POINTS) {
    return { anomaly: false, reason: "not_enough_history", prior_points: prior.length };
  }
  const all = stats(prior.map((p) => p.value));
  const z = zOf(current.value, all, opts.isCount);
  if (z === null) return { anomaly: false, reason: "flat_history", prior_points: prior.length };
  if (Math.abs(z) < ANOMALY_Z) return { anomaly: false, reason: "within_normal", z, prior_points: prior.length };

  let weekday_z: number | null = null;
  let typical = all.mean;
  if (opts.kind === "daily") {
    const same = prior.filter((p) => (daysBetween(p.date, date) - 1) % 7 === 0);
    if (same.length < MIN_PRIOR_POINTS) {
      return { anomaly: false, reason: "not_enough_history", z, prior_points: same.length };
    }
    const wd = stats(same.map((p) => p.value));
    weekday_z = zOf(current.value, wd, opts.isCount);
    if (weekday_z === null || Math.abs(weekday_z) < ANOMALY_Z || Math.sign(weekday_z) !== Math.sign(z)) {
      return { anomaly: false, reason: "weekday_normal", z, prior_points: prior.length };
    }
    typical = wd.mean;
  }

  return {
    anomaly: true,
    direction: z > 0 ? "up" : "down",
    date,
    value: current.value,
    z,
    weekday_z,
    typical,
    baseline_mean: all.mean,
    prior_points: prior.length,
  };
}

export function severityOf(z: number, weekday_z: number | null): number {
  return weekday_z === null ? Math.abs(z) : Math.min(Math.abs(z), Math.abs(weekday_z));
}

export function unusualWords(z: number): string {
  const a = Math.abs(z);
  if (a >= 4) return "far outside its normal range";
  if (a >= 3) return "well outside its normal range";
  return "outside its normal range";
}

export function isBadMove(metricDirection: "up" | "down" | "context", moved: "up" | "down"): boolean | null {
  if (metricDirection === "context") return null;
  return metricDirection === "up" ? moved === "down" : moved === "up";
}

export type MetricAnomalyWake = {
  incident_id: string;
  family: string;
  metric_id: string;
  label: string;
  date: LocalDate;
  direction: "up" | "down";
  value: number | null;
  typical: number | null;
  how_unusual: string;
  supporting: Array<{ metric_id: string; label: string; direction: "up" | "down"; value: number | null; typical: number | null }>;
  contributors: Array<{ dimension: string; segment: string; share_pct: number; confidence: "high" | "medium" | "low" }>;
};
