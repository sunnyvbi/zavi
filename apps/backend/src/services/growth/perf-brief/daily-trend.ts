
import type { MetaDailyRow } from "@/services/tools/meta-ads/daily_series";
import type { GoogleDailyRow } from "@/services/tools/google-ads/daily_series";

export type DailyTrendPoint = {
  date: string;
  spend_usd: number;
  impressions: number;
  clicks: number;
  bookings: number;
  revenue_usd: number;
  roas: number | null;
  ctr_percent: number | null;
  cpc_usd: number | null;
  cpm_usd: number | null;
  cost_per_booking_usd: number | null;
  maturing: boolean;
};

export const MATURING_DAYS = 3;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function subDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

type RawSums = {
  spend: number;
  impressions: number;
  clicks: number;
  bookings: number;
  revenue: number;
};

export function buildDailyTrend(
  metaRows: MetaDailyRow[],
  googleRows: GoogleDailyRow[],
  opts?: { maturingDays?: number; nowIso?: string },
): DailyTrendPoint[] {
  const maturingDays = opts?.maturingDays ?? MATURING_DAYS;
  const byDate = new Map<string, RawSums>();

  const bump = (date: string, patch: Partial<RawSums>) => {
    if (!date) return;
    const cur =
      byDate.get(date) ??
      ({ spend: 0, impressions: 0, clicks: 0, bookings: 0, revenue: 0 } as RawSums);
    cur.spend += patch.spend ?? 0;
    cur.impressions += patch.impressions ?? 0;
    cur.clicks += patch.clicks ?? 0;
    cur.bookings += patch.bookings ?? 0;
    cur.revenue += patch.revenue ?? 0;
    byDate.set(date, cur);
  };

  for (const r of metaRows) {
    bump(r.date, {
      spend: r.spend_usd,
      impressions: r.impressions,
      clicks: r.clicks,
      bookings: r.purchases,
      revenue: r.purchase_value_usd,
    });
  }
  for (const r of googleRows) {
    bump(r.date, {
      spend: r.spend_usd,
      impressions: r.impressions,
      clicks: r.clicks,
      bookings: r.conversions,
      revenue: r.conversions_value_usd,
    });
  }

  const dates = [...byDate.keys()].sort((a, b) => a.localeCompare(b));
  const maturingFromIso = opts?.nowIso
    ? subDaysIso(opts.nowIso, maturingDays - 1)
    : null;
  const maturingCutIdx = Math.max(0, dates.length - maturingDays);

  return dates.map((date, i) => {
    const s = byDate.get(date)!;
    const maturing = maturingFromIso
      ? date >= maturingFromIso && date <= opts!.nowIso!
      : i >= maturingCutIdx;
    return {
      date,
      spend_usd: round2(s.spend),
      impressions: Math.round(s.impressions),
      clicks: Math.round(s.clicks),
      bookings: round2(s.bookings),
      revenue_usd: round2(s.revenue),
      roas: s.spend > 0 ? round2(s.revenue / s.spend) : null,
      ctr_percent: s.impressions > 0 ? round2((s.clicks / s.impressions) * 100) : null,
      cpc_usd: s.clicks > 0 ? round2(s.spend / s.clicks) : null,
      cpm_usd: s.impressions > 0 ? round2((s.spend / s.impressions) * 1000) : null,
      cost_per_booking_usd: s.bookings > 0 ? round2(s.spend / s.bookings) : null,
      maturing,
    };
  });
}
