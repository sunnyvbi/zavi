export type AdSums = { spend: number; impressions: number; clicks: number; conversions: number };
export type AdTotals = {
  spend: number | null;
  impressions: number;
  clicks: number;
  conversions: number;
  ctr: number | null;
  cpc: number | null;
  cpa: number | null;
};

export const ZERO_AD_SUMS: AdSums = { spend: 0, impressions: 0, clicks: 0, conversions: 0 };

export const AD_RANGES = [
  { id: "7d", label: "Last 7 days", days: 7 },
  { id: "14d", label: "Last 14 days", days: 14 },
  { id: "30d", label: "Last 30 days", days: 30 },
] as const;

export const ymd = (d: Date) => d.toISOString().slice(0, 10);
export const round2 = (n: number) => Math.round(n * 100) / 100;
export const costPer = (spend: number, n: number) => (n > 0 ? round2(spend / n) : null);

export function addAdSums(a: AdSums, b: AdSums): AdSums {
  return {
    spend: a.spend + b.spend,
    impressions: a.impressions + b.impressions,
    clicks: a.clicks + b.clicks,
    conversions: a.conversions + b.conversions,
  };
}

export function adWindow(days: number, now = new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const start = new Date(end.getTime() - (days - 1) * 86_400_000);
  const prevEnd = new Date(start.getTime() - 86_400_000);
  const prevStart = new Date(prevEnd.getTime() - (days - 1) * 86_400_000);
  return {
    period: { from: ymd(start), to: ymd(end) },
    prev_period: { from: ymd(prevStart), to: ymd(prevEnd) },
  };
}

export type AdRange = { since: string; until: string };

export function adWindowFor(days: number, range?: AdRange | null, now = new Date()) {
  if (!range) return { ...adWindow(days, now), days, key: String(days) };
  const day = 86_400_000;
  const from = Date.parse(`${range.since}T00:00:00Z`);
  const span = Math.round((Date.parse(`${range.until}T00:00:00Z`) - from) / day) + 1;
  return {
    period: { from: range.since, to: range.until },
    prev_period: { from: ymd(new Date(from - span * day)), to: ymd(new Date(from - day)) },
    days: span,
    key: `${range.since}_${range.until}`,
  };
}

export function adTotals(s: AdSums, currency: string | null): AdTotals {
  return {
    spend: currency ? round2(s.spend) : null,
    impressions: s.impressions,
    clicks: s.clicks,
    conversions: s.conversions,
    ctr: s.impressions > 0 ? round2((s.clicks / s.impressions) * 100) : null,
    cpc: currency ? costPer(s.spend, s.clicks) : null,
    cpa: currency ? costPer(s.spend, s.conversions) : null,
  };
}
