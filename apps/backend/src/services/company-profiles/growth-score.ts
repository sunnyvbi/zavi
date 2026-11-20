const GROWTH_KEYS = [
  { key: "stripe_mrr", invert: false, label: "MRR" },
  { key: "weekly_signups", invert: false, label: "signups" },
  { key: "weekly_bookings", invert: false, label: "bookings" },
  { key: "ads_cpa_7d", invert: true, label: "CPA" },
] as const;

export type GrowthMetricPair = {
  latest: number;
  previous: number;
};

export type GrowthScore = {
  score: number;
  note: string;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function computeGrowthScore(
  metrics: Map<string, GrowthMetricPair>,
): GrowthScore | null {
  const parts: number[] = [];
  const used: string[] = [];
  for (const { key, invert, label } of GROWTH_KEYS) {
    const pair = metrics.get(key);
    if (!pair || !Number.isFinite(pair.latest) || !Number.isFinite(pair.previous)) continue;
    if (pair.previous === 0) continue;
    let change = (pair.latest - pair.previous) / Math.abs(pair.previous);
    if (invert) change = -change;
    parts.push(clamp(change, -1, 1));
    used.push(label);
  }
  if (parts.length < 2) return null;
  const avg = parts.reduce((sum, n) => sum + n, 0) / parts.length;
  return {
    score: Math.round((avg + 1) * 50),
    note: used.join(" + "),
  };
}
