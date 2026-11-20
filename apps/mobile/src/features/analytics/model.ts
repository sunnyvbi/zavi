
export type RangeKey = "7d" | "30d" | "90d";
export type AdScope = "all" | "meta" | "google";

export const RANGE_OPTIONS: { value: RangeKey; label: string }[] = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
];

const RANGE_DAYS: Record<RangeKey, number> = { "7d": 7, "30d": 30, "90d": 90 };

export function localYmd(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export function rangeDates(range: RangeKey, now: Date): { start: string; end: string } {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (RANGE_DAYS[range] - 1));
  return { start: localYmd(start), end: localYmd(today) };
}

export function adsQuery(range: RangeKey, now: Date, refresh = false): string {
  let q: string;
  if (range === "7d") q = "window=last_7d";
  else if (range === "30d") q = "window=last_30d";
  else {
    const { start, end } = rangeDates(range, now);
    q = `window=last_month&since=${start}&until=${end}`;
  }
  return refresh ? `${q}&refresh=1` : q;
}

export type AdTotals = {
  spend_usd: number;
  conversions: number;
  revenue_usd: number;
  roas: number | null;
  cpa_usd: number | null;
  impressions: number;
  clicks: number;
  ctr_percent: number | null;
  cpc_usd: number | null;
  cpm_usd: number | null;
};

export type TrendPoint = {
  date: string;
  spend_usd: number;
  impressions: number;
  clicks: number;
  bookings?: number;
  revenue_usd?: number;
  maturing?: boolean;
};

export type AdsView = {
  connected: { meta: boolean; google: boolean };
  windowLabel: string;
  stale: boolean;
  lastGood: boolean;
  errors: string[];
  fetchedAt: string | null;
  totals: Record<AdScope, AdTotals | null>;
  series: Record<AdScope, TrendPoint[]>;
};

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function totalsOf(raw: unknown): AdTotals | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return {
    spend_usd: num(r.spend_usd),
    conversions: num(r.conversions),
    revenue_usd: num(r.revenue_usd),
    roas: numOrNull(r.roas),
    cpa_usd: numOrNull(r.cpa_usd),
    impressions: num(r.impressions),
    clicks: num(r.clicks),
    ctr_percent: numOrNull(r.ctr_percent),
    cpc_usd: numOrNull(r.cpc_usd),
    cpm_usd: numOrNull(r.cpm_usd),
  };
}

function pointsOf(raw: unknown): TrendPoint[] {
  const pts = (raw as { points?: unknown } | null | undefined)?.points;
  if (!Array.isArray(pts)) return [];
  return pts
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object" && typeof (p as { date?: unknown }).date === "string")
    .map((p) => ({
      date: p.date as string,
      spend_usd: num(p.spend_usd),
      impressions: num(p.impressions),
      clicks: num(p.clicks),
      bookings: numOrNull(p.bookings) ?? undefined,
      revenue_usd: numOrNull(p.revenue_usd) ?? undefined,
      maturing: p.maturing === true,
    }));
}

export function normalizeAds(raw: unknown): AdsView {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const conn = (d.connected ?? {}) as { meta?: unknown; google?: unknown };
  const channels = Array.isArray(d.channels) ? (d.channels as Array<Record<string, unknown>>) : [];
  const byChannel = (d.daily_series_by_channel ?? {}) as { meta?: unknown; google?: unknown };
  const errs = (d.channel_errors ?? {}) as { meta?: { message?: string }; google?: { message?: string } };
  const errors: string[] = [];
  if (errs.meta) errors.push("Meta Ads couldn't refresh just now.");
  if (errs.google) errors.push("Google Ads couldn't refresh just now.");
  return {
    connected: { meta: conn.meta === true, google: conn.google === true },
    windowLabel: typeof d.window_label === "string" ? d.window_label : "",
    stale: d.stale === true,
    lastGood: d.served_last_good === true,
    errors,
    fetchedAt: typeof d.fetched_at === "string" ? d.fetched_at : typeof d.refreshed_at === "string" ? d.refreshed_at : null,
    totals: {
      all: totalsOf(d.kpis),
      meta: totalsOf(channels.find((c) => c.channel === "meta")),
      google: totalsOf(channels.find((c) => c.channel === "google")),
    },
    series: {
      all: pointsOf(d.daily_series),
      meta: pointsOf(byChannel.meta),
      google: pointsOf(byChannel.google),
    },
  };
}

export function adsConnected(v: AdsView | null | undefined): boolean {
  return !!v && (v.connected.meta || v.connected.google);
}

export function adScopes(v: AdsView): { value: AdScope; label: string }[] {
  const out: { value: AdScope; label: string }[] = [];
  if (v.connected.meta && v.connected.google) out.push({ value: "all", label: "Both" });
  if (v.connected.meta) out.push({ value: "meta", label: "Meta Ads" });
  if (v.connected.google) out.push({ value: "google", label: "Google Ads" });
  return out;
}

export function defaultScope(v: AdsView): AdScope {
  return v.connected.meta && v.connected.google ? "all" : v.connected.google ? "google" : "meta";
}

export type KpiDelta = { text: string; good: boolean };
export type KpiCard = { label: string; value: string; delta: KpiDelta | null };

type HalfSums = { spend: number; impressions: number; clicks: number; bookings: number; revenue: number };

function sumHalf(points: TrendPoint[], from: number, to: number): HalfSums {
  const out: HalfSums = { spend: 0, impressions: 0, clicks: 0, bookings: 0, revenue: 0 };
  for (let i = from; i < to; i++) {
    const p = points[i];
    out.spend += p.spend_usd;
    out.impressions += p.impressions;
    out.clicks += p.clicks;
    out.bookings += p.bookings ?? 0;
    out.revenue += p.revenue_usd ?? 0;
  }
  return out;
}

function pctChange(prev: number, cur: number): number | null {
  if (!(prev > 0)) return null;
  return ((cur - prev) / prev) * 100;
}

function fmtPctDelta(n: number | null, higherIsBetter: boolean): KpiDelta | null {
  if (n === null || !Number.isFinite(n)) return null;
  const rounded = Math.round(n * 10) / 10;
  if (rounded === 0) return { text: "±0%", good: true };
  const sign = rounded > 0 ? "+" : "−";
  return { text: `${sign}${Math.abs(rounded).toFixed(1)}%`, good: rounded > 0 === higherIsBetter };
}

function fmtPointDelta(n: number | null, higherIsBetter: boolean): KpiDelta | null {
  if (n === null || !Number.isFinite(n)) return null;
  const rounded = Math.round(n * 100) / 100;
  if (rounded === 0) return { text: "±0.00", good: true };
  const sign = rounded > 0 ? "+" : "−";
  return { text: `${sign}${Math.abs(rounded).toFixed(2)}`, good: rounded > 0 === higherIsBetter };
}

export type HalfDeltas = Record<
  "spend" | "impressions" | "clicks" | "ctr" | "cpc" | "cpm" | "bookings" | "cac" | "roas" | "convRate",
  KpiDelta | null
>;

export function computeHalfDeltas(points: TrendPoint[]): HalfDeltas {
  const none: HalfDeltas = {
    spend: null, impressions: null, clicks: null, ctr: null, cpc: null,
    cpm: null, bookings: null, cac: null, roas: null, convRate: null,
  };
  if (points.length < 4) return none;
  const mid = Math.floor(points.length / 2);
  const a = sumHalf(points, 0, mid);
  const b = sumHalf(points, mid, points.length);
  const ratio = (x: number, y: number, k = 1) => (y > 0 ? (x / y) * k : null);
  const pair = (x: number | null, y: number | null, f: (x: number, y: number) => KpiDelta | null) =>
    x !== null && y !== null ? f(x, y) : null;
  return {
    spend: fmtPctDelta(pctChange(a.spend, b.spend), true),
    impressions: fmtPctDelta(pctChange(a.impressions, b.impressions), true),
    clicks: fmtPctDelta(pctChange(a.clicks, b.clicks), true),
    ctr: pair(ratio(a.clicks, a.impressions, 100), ratio(b.clicks, b.impressions, 100), (x, y) => fmtPointDelta(y - x, true)),
    cpc: pair(ratio(a.spend, a.clicks), ratio(b.spend, b.clicks), (x, y) => fmtPctDelta(pctChange(x, y), false)),
    cpm: pair(ratio(a.spend, a.impressions, 1000), ratio(b.spend, b.impressions, 1000), (x, y) => fmtPctDelta(pctChange(x, y), false)),
    bookings: fmtPctDelta(pctChange(a.bookings, b.bookings), true),
    cac: pair(ratio(a.spend, a.bookings), ratio(b.spend, b.bookings), (x, y) => fmtPctDelta(pctChange(x, y), false)),
    roas: pair(ratio(a.revenue, a.spend), ratio(b.revenue, b.spend), (x, y) => fmtPointDelta(y - x, true)),
    convRate: pair(ratio(a.bookings, a.clicks, 100), ratio(b.bookings, b.clicks, 100), (x, y) => fmtPointDelta(y - x, true)),
  };
}

function group(n: number, decimals: number): string {
  const fixed = Math.abs(n).toFixed(decimals);
  const [int, frac] = fixed.split(".");
  const withCommas = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${n < 0 ? "-" : ""}${withCommas}${frac ? `.${frac}` : ""}`;
}

export function money(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : `$${group(n, 0)}`;
}
export function money2(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : `$${group(n, 2)}`;
}
export function count(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : group(n, 0);
}
export function compactCount(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n < 1000) return group(n, 0);
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, "")}K`;
  }
  const m = n / 1_000_000;
  return `${m >= 100 ? Math.round(m) : m.toFixed(1).replace(/\.0$/, "")}M`;
}
const pctValue = (n: number | null) => (n === null ? "—" : `${n.toFixed(2)}%`);
const ratioValue = (n: number | null) => (n === null ? "—" : `${n.toFixed(2)}×`);

export function adKpiCards(scope: AdScope, t: AdTotals, d: HalfDeltas): KpiCard[] {
  const convRate = t.clicks > 0 ? (t.conversions / t.clicks) * 100 : null;
  const common: KpiCard[] = [
    { label: "Amount spent", value: money(t.spend_usd), delta: d.spend },
    { label: "Bookings", value: compactCount(t.conversions), delta: d.bookings },
    { label: "CAC", value: money(t.cpa_usd), delta: d.cac },
    { label: "ROAS (all)", value: ratioValue(t.roas), delta: d.roas },
  ];
  if (scope === "google") {
    return [
      ...common,
      { label: "Clicks", value: compactCount(t.clicks), delta: d.clicks },
      { label: "Avg. CPC", value: money2(t.cpc_usd), delta: d.cpc },
      { label: "Impressions", value: compactCount(t.impressions), delta: d.impressions },
      { label: "Conv. rate", value: pctValue(convRate), delta: d.convRate },
    ];
  }
  return [
    ...common,
    { label: "Clicks", value: compactCount(t.clicks), delta: d.clicks },
    { label: "Impressions", value: compactCount(t.impressions), delta: d.impressions },
    { label: "CTR", value: pctValue(t.ctr_percent), delta: d.ctr },
    { label: "CPM", value: money2(t.cpm_usd), delta: d.cpm },
  ];
}

export function pointsInRange(points: TrendPoint[], range: RangeKey, now: Date): TrendPoint[] {
  const { start, end } = rangeDates(range, now);
  return points.filter((p) => p.date >= start && p.date <= end);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function shortDay(ymd: string): string {
  const [, m, d] = ymd.split("-").map(Number);
  return m >= 1 && m <= 12 && d ? `${MONTHS[m - 1]} ${d}` : ymd;
}

export type Bucket = { label: string; date: string; spend: number; bookings: number; clicks: number };

export function bucketAds(points: TrendPoint[], range: RangeKey): Bucket[] {
  const day = (p: TrendPoint): Bucket => ({
    label: shortDay(p.date),
    date: p.date,
    spend: p.spend_usd,
    bookings: p.bookings ?? 0,
    clicks: p.clicks,
  });
  if (range !== "90d") return points.map(day);
  const out: Bucket[] = [];
  for (let end = points.length; end > 0; end -= 7) {
    const slice = points.slice(Math.max(0, end - 7), end);
    out.unshift({
      label: shortDay(slice[0].date),
      date: slice[0].date,
      spend: Math.round(slice.reduce((s, p) => s + p.spend_usd, 0) * 100) / 100,
      bookings: slice.reduce((s, p) => s + (p.bookings ?? 0), 0),
      clicks: slice.reduce((s, p) => s + p.clicks, 0),
    });
  }
  return out;
}

export function costPerBooking(b: Bucket): number | null {
  return b.bookings > 0 ? Math.round((b.spend / b.bookings) * 100) / 100 : null;
}

export type SearchRow = { key: string; clicks: number; impressions: number; ctr: number; position: number };

export type SearchView = {
  connected: boolean;
  loadError: boolean;
  site: string | null;
  start: string | null;
  end: string | null;
  totals: { clicks: number; impressions: number; ctr: number; position: number } | null;
  series: { date: string; clicks: number; impressions: number }[];
  topQueries: SearchRow[];
  topPages: SearchRow[];
};

export type GeoBand = { key: string; label: string; weight: number; score: number };

export type GeoView = {
  ok: boolean;
  site: string | null;
  fetchedAt: string | null;
  stale: boolean;
  measured: boolean;
  score: number;
  bands: GeoBand[];
  pagesChecked: number;
  readableWithoutJs: number;
  crawlersBlocked: number;
  crawlersRecommended: number;
  issues: number;
  notChecked: string[];
};

function rowsOf(raw: unknown): SearchRow[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .map((r) => ({
      key: typeof r.key === "string" ? r.key : "",
      clicks: num(r.clicks),
      impressions: num(r.impressions),
      ctr: num(r.ctr),
      position: num(r.position),
    }));
}

export function normalizeSearch(raw: unknown): SearchView {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const t = d.totals as Record<string, unknown> | undefined;
  const series = Array.isArray(d.series) ? (d.series as Array<Record<string, unknown>>) : [];
  return {
    connected: d.connected === true,
    loadError: d.load_error === true,
    site: typeof d.site_url === "string" ? d.site_url : null,
    start: typeof d.start_date === "string" ? d.start_date : null,
    end: typeof d.end_date === "string" ? d.end_date : null,
    totals: t ? { clicks: num(t.clicks), impressions: num(t.impressions), ctr: num(t.ctr), position: num(t.position) } : null,
    series: series
      .filter((p) => typeof p.date === "string")
      .map((p) => ({ date: p.date as string, clicks: num(p.clicks), impressions: num(p.impressions) })),
    topQueries: rowsOf(d.top_queries),
    topPages: rowsOf(d.top_pages),
  };
}

export function searchHasNumbers(v: SearchView | null | undefined): boolean {
  return !!v && v.connected && !v.loadError && !!v.totals;
}

export const ctrPct = (n: number) => `${(n * 100).toFixed(1)}%`;
export const position = (n: number) => (n > 0 ? n.toFixed(1) : "—");

export function normalizeGeo(raw: unknown): GeoView | null {
  const g = (raw as { geo?: unknown } | null | undefined)?.geo;
  if (!g || typeof g !== "object") return null;
  const o = g as Record<string, unknown>;
  const crawlers = Array.isArray(o.crawlers) ? (o.crawlers as Array<Record<string, unknown>>) : [];
  const pages = Array.isArray(o.pages) ? (o.pages as Array<Record<string, unknown>>) : [];
  const score = (o.score ?? {}) as { total?: unknown; bands?: unknown };
  const pagesAnalyzed = typeof o.pages_analyzed === "number" ? o.pages_analyzed : 0;
  return {
    ok: o.status === "ok",
    site: typeof o.site === "string" ? o.site : null,
    fetchedAt: typeof o.fetched_at === "string" ? o.fetched_at : null,
    stale: o.stale === true,
    measured: pagesAnalyzed > 0,
    score: num(score.total),
    bands: Array.isArray(score.bands)
      ? (score.bands as Array<Record<string, unknown>>).map((b) => ({
          key: String(b.key ?? b.label ?? ""),
          label: typeof b.label === "string" ? b.label : "",
          weight: num(b.weight),
          score: num(b.score),
        }))
      : [],
    pagesChecked: pagesAnalyzed,
    readableWithoutJs: pages.filter((p) => p.server_rendered === true).length,
    crawlersBlocked: crawlers.filter((c) => c.recommended === true && c.state === "blocked").length,
    crawlersRecommended: crawlers.filter((c) => c.recommended === true).length,
    issues: Array.isArray(o.findings) ? o.findings.length : 0,
    notChecked: Array.isArray(o.not_checked) ? (o.not_checked as unknown[]).filter((s): s is string => typeof s === "string") : [],
  };
}

export function scoreTone(score: number): "good" | "fair" | "weak" {
  return score >= 70 ? "good" : score >= 40 ? "fair" : "weak";
}
export const SCORE_WORD = { good: "Good", fair: "Fair", weak: "Weak" } as const;

export function crawlDate(iso: string | null): string {
  return iso ? shortDay(iso.slice(0, 10)) : "";
}

export function summaryLine(ads: AdsView | null, search: SearchView | null): string {
  const adsOn = adsConnected(ads) && !!ads?.totals.all;
  const searchOn = searchHasNumbers(search);
  if (!adsOn && !searchOn) return "No numbers yet. Connect an ad account or Search Console below and this fills in.";
  const parts: string[] = [];
  if (adsOn && ads?.totals.all) {
    const t = ads.totals.all;
    parts.push(`Ads brought ${compactCount(t.conversions)} bookings for ${money(t.spend_usd)}.`);
  } else parts.push("Ads aren't connected yet.");
  if (searchOn && search?.totals) parts.push(`Google sent ${count(search.totals.clicks)} search clicks in the last 28 days.`);
  else parts.push("Search isn't connected yet.");
  return parts.join(" ");
}

export function lockOf(locks: Record<string, unknown> | null | undefined, slug: string): "starter" | "growth" | "pro" | null {
  const t = locks?.[slug];
  return t === "starter" || t === "growth" || t === "pro" ? t : null;
}

export const PLAN_NAME = { starter: "Starter", growth: "Growth", pro: "Pro" } as const;

export const RANGE_TITLE: Record<RangeKey, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
};

export function ago(iso: string | null, now: Date): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "";
  const min = Math.max(0, Math.round((now.getTime() - t) / 60000));
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}
