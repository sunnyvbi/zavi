import { roasVerdict, type ChannelMetric } from "./channelPage";
import { geoKpis } from "./geoKpis";
import { seoKpis } from "./seoKpis";

export const KPI_FALLBACK: Readonly<Record<string, string>> = {
  meta_ads: "meta",
  tiktok_ads: "tiktok_ads",
  reddit_ads: "reddit_ads",
  linkedin_ads: "linkedin_ads",
  x_ads: "x_ads",
  x_organic: "x",
  linkedin_organic: "linkedin",
  instagram_organic: "instagram",
  tiktok_organic: "tiktok",
  chatgpt_ads: "chatgpt_ads",
  seo: "seo",
  geo: "geo",
};

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v && typeof v === "object" ? (v as Rec) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const zeroed = (v: unknown): number => num(v) ?? 0;

const blank = (key: string, unit: string | null, day: string, windowKind: string | null): ChannelMetric & { window_kind: string | null; prev_day: null } => ({
  key,
  value: Number.NaN,
  unit,
  day,
  grounded: false,
  prev_value: null,
  window_kind: windowKind,
  prev_day: null,
});

const RATIO_REASON: Record<string, string> = {
  cpa: "No conversions in this period",
  cpc: "No clicks in this period",
  ctr: "No impressions in this period",
  roas: "No spend in this period",
};

function paidKpis(payload: Rec, platform: string, rows: Array<[string, string]>): ChannelMetric[] {
  if (payload.platform !== platform || payload.connected !== true || payload.error_code || !rec(payload.totals)) return [];
  const t = payload.totals as Rec;
  const p = rec(payload.prev_totals);
  const currency = rec(payload.account)?.currency;
  const cur = typeof currency === "string" ? currency : null;
  const moneyUnit = cur === "USD" ? "usd" : `currency:${cur}`;
  const day = rec(payload.period)?.to;
  const unmeasuredConv = typeof payload.conversions_unmeasured === "string" ? payload.conversions_unmeasured : null;
  return rows.map(([key, kind]) => {
    const unit = kind === "money" ? moneyUnit : kind;
    const unavailable = !cur && (kind === "money" || key === "roas");
    const noConv = (key === "cpa" || key === "conversions") && unmeasuredConv ? unmeasuredConv : undefined;
    const noRatio = noConv ?? (!unavailable && t[key] == null ? RATIO_REASON[key] : undefined);
    const prevRaw = p ? p[key] : null;
    const value = zeroed(t[key]);
    return {
      key,
      value: unavailable || noRatio ? Number.NaN : value,
      unit,
      day: typeof day === "string" ? day : "",
      grounded: !unavailable && !noRatio,
      prev_value: p && !unavailable && !noRatio && prevRaw != null ? zeroed(prevRaw) : null,
      ...(unavailable ? { unmeasured: "Totals need a single currency" } : noRatio ? { unmeasured: noRatio } : {}),
      ...(key === "roas" && cur && !noRatio && zeroed(t.spend) > 0 ? roasVerdict(value, cur) : {}),
    };
  });
}

const CLICK_ROWS: Array<[string, string]> = [
  ["spend", "money"],
  ["cpa", "money"],
  ["conversions", "count"],
  ["clicks", "count"],
  ["ctr", "pct"],
  ["cpc", "money"],
];
const ROAS_ROWS: Array<[string, string]> = [
  ["spend", "money"],
  ["cpa", "money"],
  ["conversions", "count"],
  ["conv_value", "money"],
  ["roas", "ratio"],
  ["ctr", "pct"],
];

function metaKpis(d: Rec): ChannelMetric[] {
  const channels = Array.isArray(d.channels) ? (d.channels as Rec[]) : [];
  const t = channels.find((c) => c.channel === "meta");
  if (!t) return [];
  const windowKind = typeof d.window === "string" ? d.window.replace(/^last_/, "") : null;
  const rows: Array<[string, number | null, string]> = [
    ["spend", num(t.spend_usd), "usd"],
    ["cpa", num(t.cpa_usd), "usd"],
    ["conversions", num(t.conversions), "count"],
    ["conv_value", num(t.revenue_usd), "usd"],
    ["roas", num(t.roas), "ratio"],
    ["ctr", num(t.ctr_percent), "pct"],
  ];
  return rows.map(([key, value, unit]) => ({
    ...blank(key, unit, "", windowKind),
    value: value ?? Number.NaN,
    grounded: value !== null,
    ...(key === "roas" ? roasVerdict(value) : {}),
  }));
}

const THIN_VIEWS = 100;

function xKpis(d: Rec): ChannelMetric[] {
  if (!Array.isArray(d.metrics)) return [];
  const metrics = d.metrics as Rec[];
  const day = rec(d.period)?.to;
  const views = num(metrics.find((m) => m.key === "impressions")?.value);
  const ordered = [...metrics.filter((m) => m.unit !== "pct"), ...metrics.filter((m) => m.unit === "pct")];
  return ordered.map((m) => {
    const value = num(m.value) ?? Number.NaN;
    const delta = num(m.delta);
    const prev =
      delta === null
        ? null
        : m.delta_unit === "pp"
          ? value - delta
          : delta === -100
            ? 0
            : Math.round((value / (1 + delta / 100)) * 100) / 100;
    return {
      key: String(m.key),
      value,
      unit: m.unit === "pct" ? "pct" : "count",
      day: typeof day === "string" ? day : "",
      grounded: num(m.value) !== null && m.basis !== "none",
      prev_value: prev,
      ...(m.key === "engagement_rate" && num(m.value) !== null && views !== null && views < THIN_VIEWS
        ? { note: `From only ${views} ${views === 1 ? "view" : "views"}` }
        : {}),
    };
  });
}

function passThrough(d: Rec): ChannelMetric[] {
  return Array.isArray(d.metrics) ? (d.metrics as ChannelMetric[]) : [];
}

export function fallbackMetrics(slug: string, payload: unknown): ChannelMetric[] {
  const d = rec(payload);
  const id = KPI_FALLBACK[slug];
  if (!d || !id) return [];
  try {
    switch (id) {
      case "meta":
        return metaKpis(d);
      case "tiktok_ads":
        return paidKpis(d, "tiktok_ads", ROAS_ROWS);
      case "reddit_ads":
      case "linkedin_ads":
      case "x_ads":
        return paidKpis(d, id, CLICK_ROWS);
      case "x":
        return xKpis(d);
      case "seo":
        return seoKpis(d);
      case "geo":
        return geoKpis(d);
      case "linkedin":
      case "instagram":
      case "tiktok":
        return passThrough(d);
      default:
        return [];
    }
  } catch {
    return [];
  }
}
