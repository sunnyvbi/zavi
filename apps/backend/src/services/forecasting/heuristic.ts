
export type SeriesPoint = { week_start: string; value: number };

export type ForecastResult = {
  wow_pct: number | null;
  mom_pct: number | null;
  trend: "rising" | "flat" | "falling" | "insufficient_data";
  projected_next_week: number | null;
  severity: "low" | "medium" | "high";
};

const WOW_RISING_PCT = 5;
const WOW_FALLING_PCT = -5;
const MOM_RISING_PCT = 10;
const MOM_FALLING_PCT = -10;

const MIN_POINTS_FOR_WOW = 2;
const MIN_POINTS_FOR_MOM = 8;
const MIN_POINTS_FOR_PROJECTION = 4;

export function forecastTrend(series: SeriesPoint[]): ForecastResult {
  const cleaned = sortAndDedup(series).filter((p) => Number.isFinite(p.value));

  if (cleaned.length < MIN_POINTS_FOR_WOW) {
    return {
      wow_pct: null,
      mom_pct: null,
      trend: "insufficient_data",
      projected_next_week: null,
      severity: "low",
    };
  }

  const last = cleaned[cleaned.length - 1].value;
  const prev = cleaned[cleaned.length - 2].value;
  const wow_pct = pctChange(last, prev);

  const mom_pct =
    cleaned.length >= MIN_POINTS_FOR_MOM ? momPct(cleaned) : null;

  const projected_next_week =
    cleaned.length >= MIN_POINTS_FOR_PROJECTION
      ? Math.max(0, Math.round(linearProject(cleaned)))
      : null;

  const trend = classifyTrend(wow_pct, mom_pct);
  const severity = classifySeverity(trend, last, projected_next_week);

  return { wow_pct, mom_pct, trend, projected_next_week, severity };
}

function sortAndDedup(series: SeriesPoint[]): SeriesPoint[] {
  const byKey = new Map<string, number>();
  for (const p of series) {
    if (!p || typeof p.week_start !== "string") continue;
    byKey.set(p.week_start, (byKey.get(p.week_start) ?? 0) + (Number.isFinite(p.value) ? p.value : 0));
  }
  return [...byKey.entries()]
    .map(([week_start, value]) => ({ week_start, value }))
    .sort((a, b) => (a.week_start < b.week_start ? -1 : a.week_start > b.week_start ? 1 : 0));
}

function pctChange(curr: number, prev: number): number | null {
  if (!Number.isFinite(curr) || !Number.isFinite(prev)) return null;
  if (prev === 0) {
    return curr > 0 ? 100 : 0;
  }
  return Number((((curr - prev) / Math.abs(prev)) * 100).toFixed(1));
}

function momPct(series: SeriesPoint[]): number | null {
  const n = series.length;
  const lastFour = series.slice(n - 4).reduce((sum, p) => sum + p.value, 0) / 4;
  const priorFour = series.slice(n - 8, n - 4).reduce((sum, p) => sum + p.value, 0) / 4;
  return pctChange(lastFour, priorFour);
}

function linearProject(series: SeriesPoint[]): number {
  const recent = series.slice(-4);
  const n = recent.length;
  const xMean = (n - 1) / 2;
  const yMean = recent.reduce((s, p) => s + p.value, 0) / n;
  let numer = 0;
  let denom = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - xMean;
    numer += dx * (recent[i].value - yMean);
    denom += dx * dx;
  }
  const slope = denom === 0 ? 0 : numer / denom;
  const nextX = n;
  return yMean + slope * (nextX - xMean);
}

function classifyTrend(
  wow: number | null,
  mom: number | null,
): "rising" | "flat" | "falling" | "insufficient_data" {
  if (wow === null) return "insufficient_data";
  if (wow >= WOW_RISING_PCT || (mom !== null && mom >= MOM_RISING_PCT)) return "rising";
  if (wow <= WOW_FALLING_PCT || (mom !== null && mom <= MOM_FALLING_PCT)) return "falling";
  return "flat";
}

function classifySeverity(
  trend: "rising" | "flat" | "falling" | "insufficient_data",
  lastValue: number,
  projected: number | null,
): "low" | "medium" | "high" {
  if (trend === "rising") {
    if (lastValue < 10) return "high";
    if (lastValue < 50) return "medium";
    return "low";
  }
  if (trend === "falling") {
    if (lastValue > 50) return "high";
    if (lastValue > 10) return "medium";
    return "low";
  }
  if (trend === "flat") {
    if (projected !== null && Math.abs(projected - lastValue) > lastValue * 0.25) return "medium";
    return "low";
  }
  return "low";
}
