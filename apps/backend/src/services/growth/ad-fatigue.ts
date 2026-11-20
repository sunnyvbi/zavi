
export type AdDay = {
  date: string;
  impressions: number;
  clicks: number;
  spend_usd: number;
  results: number;
};

export type AdSeries = { ad_id: string; days: readonly AdDay[] };

export type FatigueOpts = {
  recentDays?: number;
  baselineDays?: number;
  dropPct?: number;
  minImpressions?: number;
};

export type FatigueState = "fresh" | "fatigued" | "unknown";

export type RankedAd = {
  ad_id: string;
  spend_usd: number;
  results: number;
  cost_per_result: number | null;
  ctr_recent: number | null;
  ctr_baseline: number | null;
  ctr_drop: number | null;
  fatigue: FatigueState;
};

const DEFAULTS: Required<FatigueOpts> = { recentDays: 7, baselineDays: 14, dropPct: 0.25, minImpressions: 1000 };

function sum(days: readonly AdDay[], k: keyof Omit<AdDay, "date">): number {
  return days.reduce((s, d) => s + (Number.isFinite(d[k]) ? d[k] : 0), 0);
}

export function adFatigue(series: AdSeries, opts: FatigueOpts = {}): Pick<RankedAd, "ctr_recent" | "ctr_baseline" | "ctr_drop" | "fatigue"> {
  const o = { ...DEFAULTS, ...opts };
  const days = [...series.days].sort((a, b) => a.date.localeCompare(b.date));
  const recent = days.slice(-o.recentDays);
  const baseline = days.slice(-(o.recentDays + o.baselineDays), -o.recentDays);
  const ri = sum(recent, "impressions");
  const bi = sum(baseline, "impressions");
  if (ri < o.minImpressions || bi < o.minImpressions) {
    return {
      ctr_recent: ri > 0 ? sum(recent, "clicks") / ri : null,
      ctr_baseline: bi > 0 ? sum(baseline, "clicks") / bi : null,
      ctr_drop: null,
      fatigue: "unknown",
    };
  }
  const ctr_recent = sum(recent, "clicks") / ri;
  const ctr_baseline = sum(baseline, "clicks") / bi;
  if (ctr_baseline <= 0) return { ctr_recent, ctr_baseline, ctr_drop: null, fatigue: "unknown" };
  const ctr_drop = (ctr_baseline - ctr_recent) / ctr_baseline;
  return { ctr_recent, ctr_baseline, ctr_drop, fatigue: ctr_drop >= o.dropPct ? "fatigued" : "fresh" };
}

export function rankAdsWithFatigue(ads: readonly AdSeries[], opts: FatigueOpts = {}): RankedAd[] {
  const o = { ...DEFAULTS, ...opts };
  const window = o.recentDays + o.baselineDays;
  const rows: RankedAd[] = ads.map((a) => {
    const days = [...a.days].sort((x, y) => x.date.localeCompare(y.date)).slice(-window);
    const spend_usd = Math.round(sum(days, "spend_usd") * 100) / 100;
    const results = sum(days, "results");
    return {
      ad_id: a.ad_id,
      spend_usd,
      results,
      cost_per_result: results > 0 ? spend_usd / results : null,
      ...adFatigue(a, o),
    };
  });
  const tier = (r: RankedAd): number => {
    if (r.spend_usd <= 0) return 3;
    if (r.cost_per_result === null) return 2;
    return r.fatigue === "fatigued" ? 1 : 0;
  };
  return rows.sort((a, b) => {
    const t = tier(a) - tier(b);
    if (t !== 0) return t;
    if (a.cost_per_result !== null && b.cost_per_result !== null && a.cost_per_result !== b.cost_per_result) {
      return a.cost_per_result - b.cost_per_result;
    }
    return b.spend_usd - a.spend_usd || a.ad_id.localeCompare(b.ad_id);
  });
}
