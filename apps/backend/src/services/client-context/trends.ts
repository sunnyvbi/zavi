
import { fetchMetaDailySeries } from "@/services/tools/meta-ads/daily_series";
import { fetchGoogleDailySeries } from "@/services/tools/google-ads/daily_series";
import { runReport as gaRunReport } from "@/services/tools/google-analytics/_client";
import { getSecret } from "@/services/secrets/vault";
import { GOOGLE_ANALYTICS_VAULT_KEYS } from "@/services/tools/google-analytics/keys";

export type TrendPoint = {
  date: string;
  spend_usd: number | null;
  revenue_usd: number | null;
  leads: number | null;
  customers: number | null;
  sessions: number | null;
  cac_usd: number | null;
  roas: number | null;
  conversion_rate: number | null;
};

export type ChannelTrendPoint = {
  date: string;
  by_channel: Record<string, number>;
};

export type TrendsSection = {
  points: TrendPoint[];
  channel_points: ChannelTrendPoint[];
  sources: string[];
  window: { since: string; until: string };
};

type DayAccumulator = {
  spend: number | null;
  revenue: number | null;
  leads: number | null;
  customers: number | null;
  sessions: number | null;
};

function blank(): DayAccumulator {
  return { spend: null, revenue: null, leads: null, customers: null, sessions: null };
}

function add(current: number | null, delta: number | undefined): number | null {
  if (delta === undefined || !Number.isFinite(delta)) return current;
  return (current ?? 0) + delta;
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator <= 0) return null;
  return numerator / denominator;
}

function ymd(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}
function ymdEndExclusive(isoExclusive: string): string {
  return new Date(Date.parse(isoExclusive) - 86_400_000).toISOString().slice(0, 10);
}

function num(v?: string): number {
  const n = Number(v ?? "0");
  return Number.isFinite(n) ? n : 0;
}

function ga4Date(raw: string): string | null {
  return /^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : null;
}

const PAID_MEDIUM = /^(cpc|ppc|paid|paidsearch|paid_search|paid_social|display|cpm|retargeting)$/i;

function channelBucket(source: string, medium: string): string {
  const m = medium.toLowerCase();
  if (PAID_MEDIUM.test(m)) return "Paid";
  if (m === "organic") return "Organic Search";
  if (m === "referral") return "Referral";
  if (m === "social" || m === "organic_social") return "Organic Social";
  if (m === "email") return "Email";
  if (source === "(direct)" || m === "(none)") return "Direct";
  return "Other";
}

export async function loadTrends(
  tenant_id: string,
  window: { since: string; until: string },
): Promise<TrendsSection> {
  const since = ymd(window.since);
  const until = ymdEndExclusive(window.until);
  const days = new Map<string, DayAccumulator>();
  const channelDays = new Map<string, Record<string, number>>();
  const sources: string[] = [];

  const touch = (date: string): DayAccumulator => {
    const existing = days.get(date);
    if (existing) return existing;
    const created = blank();
    days.set(date, created);
    return created;
  };

  const [meta, google, ga] = await Promise.all([
    fetchMetaDailySeries(tenant_id, { level: "campaign", time_range: { since, until } }).catch(() => null),
    fetchGoogleDailySeries(tenant_id, { custom_range: { since, until } }).catch(() => null),
    loadGaDaily(tenant_id, since, until).catch(() => null),
  ]);

  if (meta && meta.rows.length > 0) {
    sources.push("meta_ads");
    for (const row of meta.rows) {
      const day = touch(row.date);
      day.spend = add(day.spend, row.spend_usd);
      day.revenue = add(day.revenue, row.purchase_value_usd);
      day.leads = add(day.leads, row.clicks);
      day.customers = add(day.customers, row.purchases);
    }
  }

  if (google && google.rows.length > 0) {
    sources.push("google_ads");
    for (const row of google.rows) {
      const day = touch(row.date);
      day.spend = add(day.spend, row.spend_usd);
      day.revenue = add(day.revenue, row.conversions_value_usd);
      day.leads = add(day.leads, row.clicks);
      day.customers = add(day.customers, row.conversions);
    }
  }

  if (ga && ga.rows.length > 0) {
    sources.push("ga4");
    for (const row of ga.rows) {
      const day = touch(row.date);
      day.sessions = add(day.sessions, row.sessions);
    }
    for (const row of ga.channelRows) {
      const bucket = channelDays.get(row.date) ?? {};
      bucket[row.channel] = (bucket[row.channel] ?? 0) + row.revenue;
      channelDays.set(row.date, bucket);
    }
  }

  const points: TrendPoint[] = [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, day]) => ({
      date,
      spend_usd: day.spend,
      revenue_usd: day.revenue,
      leads: day.leads,
      customers: day.customers,
      sessions: day.sessions,
      cac_usd: ratio(day.spend, day.customers),
      roas: ratio(day.revenue, day.spend),
      conversion_rate: ratio(day.customers, day.sessions ?? day.leads),
    }));

  const channel_points: ChannelTrendPoint[] = [...channelDays.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, by_channel]) => ({ date, by_channel }));

  return { points, channel_points, sources, window };
}

async function loadGaDaily(
  tenant_id: string,
  since: string,
  until: string,
): Promise<{
  rows: Array<{ date: string; sessions: number; conversions: number; revenue: number }>;
  channelRows: Array<{ date: string; channel: string; revenue: number }>;
}> {
  const property = await getSecret(tenant_id, GOOGLE_ANALYTICS_VAULT_KEYS.property_id);
  if (!property) return { rows: [], channelRows: [] };

  const [daily, byChannel] = await Promise.all([
    gaRunReport(tenant_id, {
      dateRanges: [{ startDate: since, endDate: until }],
      dimensions: [{ name: "date" }],
      metrics: [{ name: "sessions" }, { name: "conversions" }, { name: "purchaseRevenue" }],
      limit: "400",
    }),
    gaRunReport(tenant_id, {
      dateRanges: [{ startDate: since, endDate: until }],
      dimensions: [{ name: "date" }, { name: "sessionSource" }, { name: "sessionMedium" }],
      metrics: [{ name: "purchaseRevenue" }],
      limit: "2000",
    }),
  ]);

  const rows = (daily.rows ?? []).flatMap((row) => {
    const date = ga4Date(row.dimensionValues?.[0]?.value ?? "");
    if (!date) return [];
    return [
      {
        date,
        sessions: num(row.metricValues?.[0]?.value),
        conversions: num(row.metricValues?.[1]?.value),
        revenue: num(row.metricValues?.[2]?.value),
      },
    ];
  });

  const channelRows = (byChannel.rows ?? []).flatMap((row) => {
    const date = ga4Date(row.dimensionValues?.[0]?.value ?? "");
    if (!date) return [];
    const revenue = num(row.metricValues?.[0]?.value);
    if (revenue <= 0) return [];
    return [
      {
        date,
        channel: channelBucket(
          row.dimensionValues?.[1]?.value ?? "",
          row.dimensionValues?.[2]?.value ?? "",
        ),
        revenue,
      },
    ];
  });

  return { rows, channelRows };
}
