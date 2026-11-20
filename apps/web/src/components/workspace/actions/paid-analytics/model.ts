import { metaKpis } from "../../agent/metaAdsTables";
import { formatCurrency } from "../../metrics/currency";
import type { GadsPayload } from "../../agent/google-ads/types";
import { isTiktokPayload, statusCell, type TiktokPayload } from "../../agent/tiktokAdsTables";
import { words } from "../tiktok-campaigns/types";
import type { PaidAdsCampaign, PaidAdsPayload } from "../../agent/paidAdsTables";

export type PaidAnalyticsKind = "meta" | "google" | "youtube" | "tiktok" | "x" | "reddit";
export type AnalyticsRow = { id: string; name: string; status: string | null; spend: number | null; conversions: number | null; cpa: number | null; value: number | null; budget?: number | null; shared?: boolean; limited?: boolean; subtitle?: string; end?: string | null; channelType?: string | null; views?: number | null; viewRate?: number | null; cpv?: number | null; clicks?: number | null; impressions?: number | null; engagements?: number | null; url?: string | null; advertiserId?: string; currency?: string | null; note?: string };
export type VideoTotals = { views: number | null; viewRate: number | null; cpv: number | null; clicks: number | null; ctr?: number | null; cpa?: number | null };
export type AnalyticsMetric = { key: string; label: string; value: number | null; unit: "money" | "count" | "ratio" | "pct"; note?: string; help?: string; precise?: boolean };
type Meta = {
  channels?: unknown[];
  campaigns?: Array<{ channel: string; campaign_id: string; campaign_name: string; status?: string; spend_usd?: number; conversions?: number; cpa_usd?: number | null; revenue_usd?: number; active_daily_budget_usd?: number | null; objective_label?: string; end_time?: string | null }>;
  meta_currency?: string | null;
  period?: { from: string; to: string };
  meta_daily_budget?: { total_daily_budget_usd: number | null; active_campaigns: number; truncated?: boolean } | null;
};
export const numeric = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;
type BudgetTotal = { total_daily_budget_usd: number | null; active_campaigns: number; known_daily_budget_usd?: number | null; known_campaigns?: number } | null | undefined;
function budgetOf(b: BudgetTotal, readable: boolean) {
  const active = numeric(b?.active_campaigns);
  const known = numeric(b?.known_campaigns);
  return {
    budget: readable ? numeric(b?.total_daily_budget_usd) ?? numeric(b?.known_daily_budget_usd) : null,
    activeCount: readable ? active : null,
    budgetCounted: readable && known != null && active != null && known > 0 && known < active ? known : null,
  };
}
const LABELS: Record<string, string> = { spend: "Spend", cpa: "Cost per conversion", conversions: "Conversions", conv_value: "Conversion value", roas: "ROAS", ctr: "Click-through rate", pacing: "Plan pace" };

type Video = Omit<GadsPayload, "campaigns" | "totals"> & {
  campaigns?: Array<GadsPayload["campaigns"][number] & { impressions?: number | null; clicks?: number | null; goal?: string | null }>;
  totals?: (NonNullable<GadsPayload["totals"]> & { impressions?: number | null; clicks?: number | null }) | null;
};

function youtubeModel(d: Video) {
  const t = d.totals ?? null;
  const readable = d.connected !== false && !d.error_code && Array.isArray(d.campaigns) && !!t;
  const currency = d.currency ?? null;
  const impressions = numeric(t?.impressions);
  const cpa = numeric(t?.cpa);
  const metrics: AnalyticsMetric[] = [
    { key: "spend", label: "Spend", value: numeric(t?.spend), unit: "money", precise: true, help: "Across your campaigns" },
    { key: "views", label: "Views", value: numeric(t?.views), unit: "count", help: "Watched 30 seconds, or the whole ad" },
    { key: "view_rate", label: "View rate", value: numeric(t?.view_rate), unit: "pct", precise: true, help: impressions == null ? "Views divided by impressions" : `Of ${impressions.toLocaleString("en-US")} impressions` },
    { key: "cpv", label: "Average cost per view", value: numeric(t?.cpv), unit: "money", precise: true, help: "Spend divided by views" },
    { key: "conversions", label: "Conversions", value: numeric(t?.conversions), unit: "count", help: cpa == null ? "No cost per conversion yet" : `${formatCurrency(cpa, currency, true)} per conversion` },
  ];
  const rows: AnalyticsRow[] = !readable ? [] : (d.campaigns ?? []).map(c => ({ id: c.id, name: c.name, status: c.status, spend: numeric(c.spend), conversions: numeric(c.conversions), cpa: numeric(c.cpa), value: numeric(c.conv_value), budget: numeric(c.daily_budget), shared: c.budget_shared, channelType: c.channel_type, subtitle: c.goal ?? undefined, views: numeric(c.views), viewRate: numeric(c.view_rate), cpv: numeric(c.cpv), clicks: numeric(c.clicks), impressions: numeric(c.impressions) }));
  const video: VideoTotals | null = readable ? { views: numeric(t?.views), viewRate: numeric(t?.view_rate), cpv: numeric(t?.cpv), clicks: numeric(t?.clicks) } : null;
  return { metrics: readable ? metrics : metrics.map(m => ({ ...m, value: null })), rows, readable, pacing: null, currency: readable ? currency : null, period: d.period, video,
    ...budgetOf(d.daily_budget, readable), budgetPartial: false };
}

const TIKTOK_GOALS: Record<string, string> = { TRAFFIC: "Website visits", VIDEO_VIEWS: "Video views", REACH: "Reach", ENGAGEMENT: "Engagement", LEAD_GENERATION: "Leads", WEB_CONVERSIONS: "Website conversions", APP_PROMOTION: "App promotion", PRODUCT_SALES: "Product sales" };

function tiktokModel(raw: unknown) {
  const d = isTiktokPayload(raw) ? raw : ({} as Partial<TiktokPayload>);
  const t = d.totals ?? null;
  const readable = d.connected === true && !d.error_code && !!t;
  const currency = d.account?.currency ?? null;
  const spend = numeric(t?.spend);
  const impressions = numeric(t?.impressions);
  const ctr = numeric(t?.ctr);
  const cpa = numeric(t?.cpa);
  const metrics: AnalyticsMetric[] = [
    { key: "spend", label: "Spend", value: spend, unit: "money", precise: true, help: "Across your campaigns" },
    { key: "views", label: "Video views", value: numeric(t?.views), unit: "count", help: "Watched for 2 seconds or more" },
    { key: "cpm", label: "Cost per 1,000 impressions", value: spend != null && impressions ? (spend / impressions) * 1000 : null, unit: "money", precise: true, help: impressions == null ? "Spend divided by impressions" : `${impressions.toLocaleString("en-US")} impressions` },
    { key: "clicks", label: "Clicks", value: numeric(t?.clicks), unit: "count", help: ctr == null ? "No click-through rate yet" : `${ctr.toFixed(2)}% click-through rate` },
    { key: "conversions", label: "Conversions", value: numeric(t?.conversions), unit: "count", help: cpa == null ? "No cost per conversion yet" : `${formatCurrency(cpa, currency, true)} per conversion` },
  ];
  const rows: AnalyticsRow[] = !readable ? [] : (d.campaigns ?? []).map(c => {
    const delivery = statusCell(c.status, c.secondary_status, c.ad_groups).text;
    return { id: c.id, name: c.name, status: c.status, spend: numeric(c.spend), conversions: numeric(c.conversions), cpa: numeric(c.cpa), value: numeric(c.conv_value), budget: numeric(c.daily_budget), subtitle: c.objective ? TIKTOK_GOALS[c.objective] ?? words(c.objective) : undefined, views: numeric(c.views), clicks: numeric(c.clicks), impressions: numeric(c.impressions), advertiserId: c.advertiser_id, currency: c.currency, note: c.status === "ACTIVE" && delivery !== "Enabled" ? delivery : undefined };
  });
  const video: VideoTotals | null = readable ? { views: numeric(t?.views), viewRate: null, cpv: null, clicks: numeric(t?.clicks), ctr, cpa } : null;
  return { metrics: readable ? metrics : metrics.map(m => ({ ...m, value: null })), rows, readable, pacing: null, currency: readable ? currency : null, period: d.period, video,
    ...budgetOf(d.daily_budget, readable), budgetPartial: false };
}

type AdsPayload = Omit<PaidAdsPayload<"x_ads" | "reddit_ads">, "campaigns"> & {
  campaigns?: Array<PaidAdsCampaign & { ad_account_id?: string; impressions?: number | null; engagements?: number | null; link_clicks_unmeasured?: boolean }>;
  engagements?: number | null;
  link_clicks_unmeasured?: boolean;
  daily_budget?: { total_daily_budget_usd: number | null; active_campaigns: number } | null;
};

function adsModel(raw: unknown, platform: "x_ads" | "reddit_ads") {
  const d = (raw as { platform?: unknown }).platform === platform ? (raw as AdsPayload) : ({} as Partial<AdsPayload>);
  const t = d.totals ?? null;
  const readable = d.connected === true && !d.error_code && !!t;
  const currency = d.account?.currency ?? null;
  const measured = !d.conversions_unmeasured;
  const spend = numeric(t?.spend);
  const impressions = numeric(t?.impressions);
  const engagements = numeric(d.engagements);
  const unread = d.link_clicks_unmeasured === true;
  const clicks = unread ? null : numeric(t?.clicks);
  const ctr = numeric(t?.ctr);
  const cpc = unread ? null : numeric(t?.cpc);
  const cpa = measured ? numeric(t?.cpa) : null;
  const x = platform === "x_ads";
  const metrics: AnalyticsMetric[] = [
    { key: "spend", label: "Spend", value: spend, unit: "money", precise: true, help: "Across your campaigns" },
    { key: "impressions", label: "Impressions", value: impressions, unit: "count", help: spend != null && impressions ? `${formatCurrency((spend / impressions) * 1000, currency, true)} per 1,000 impressions` : "No cost per 1,000 impressions yet" },
    ...(x
      ? [{ key: "engagements", label: "Engagements", value: engagements, unit: "count" as const, help: engagements != null && impressions ? `${((engagements / impressions) * 100).toFixed(2)}% engagement rate` : "No engagement rate yet" }]
      : []),
    { key: "clicks", label: x ? "Link clicks" : "Clicks", value: clicks, unit: "count", help: !x ? (ctr == null ? "No click-through rate yet" : `${ctr.toFixed(2)}% click-through rate`) : unread ? "X did not report link clicks for every campaign" : cpc == null ? "No cost per link click yet" : `${formatCurrency(cpc, currency, true)} per link click` },
    ...(x ? [] : [
      { key: "ctr", label: "Click-through rate", value: ctr, unit: "pct" as const, precise: true, help: "Clicks per impression" },
      { key: "cpc", label: "Cost per click", value: cpc, unit: "money" as const, precise: true, help: "Spend divided by clicks" },
    ]),
    { key: "conversions", label: "Conversions", value: measured ? numeric(t?.conversions) : null, unit: "count", help: !measured ? "Conversions were not reported for this account" : cpa == null ? "No cost per conversion yet" : `${formatCurrency(cpa, currency, true)} per conversion` },
  ];
  const rows: AnalyticsRow[] = !readable ? [] : (d.campaigns ?? []).map(c => ({ id: c.id, name: c.name, status: c.status, spend: numeric(c.spend), conversions: measured ? numeric(c.conversions) : null, cpa: measured ? numeric(c.cpa) : null, value: null, budget: numeric(c.daily_budget), clicks: c.link_clicks_unmeasured ? null : numeric(c.clicks), impressions: numeric(c.impressions), engagements: numeric(c.engagements), url: c.url, advertiserId: c.ad_account_id, currency: c.currency }));
  return { metrics: readable ? metrics : metrics.map(m => ({ ...m, value: null })), rows, readable, pacing: null, currency: readable ? currency : null, period: d.period, video: null as VideoTotals | null,
    ...budgetOf(d.daily_budget, readable), budgetPartial: false };
}

export function paidAnalyticsModel(kind: PaidAnalyticsKind, payload: unknown) {
  const raw = payload && typeof payload === "object" ? payload : {};
  if (kind === "youtube") return youtubeModel(raw as Video);
  if (kind === "tiktok") return tiktokModel(raw);
  if (kind === "x" || kind === "reddit") return adsModel(raw, kind === "x" ? "x_ads" : "reddit_ads");
  const meta = raw as Meta;
  const google = raw as GadsPayload;
  const source = kind === "meta" ? metaKpis(raw) : google.kpis ?? [];
  const keys = kind === "meta" ? ["spend", "cpa", "conversions", "conv_value", "roas", "ctr"] : ["spend", "conversions", "cpa", "conv_value", "roas", "pacing"];
  const metrics: AnalyticsMetric[] = keys.map(key => ({
    key, label: LABELS[key], value: numeric(source.find(m => m.key === key)?.value),
    unit: key === "conversions" ? "count" : key === "roas" ? "ratio" : key === "ctr" || key === "pacing" ? "pct" : "money",
  }));
  const readable = source.length > 0;
  const rows: AnalyticsRow[] = !readable ? [] : kind === "meta"
    ? (meta.campaigns ?? []).filter(c => c.channel === "meta").map(c => ({ id: c.campaign_id, name: c.campaign_name, status: c.status ?? null, spend: numeric(c.spend_usd), conversions: numeric(c.conversions), cpa: numeric(c.cpa_usd), value: numeric(c.revenue_usd), budget: numeric(c.active_daily_budget_usd), subtitle: c.objective_label, end: c.end_time }))
    : [...(google.campaigns ?? []).map(c => ({ id: c.id, name: c.name, status: c.status, spend: numeric(c.spend), conversions: numeric(c.conversions), cpa: numeric(c.cpa), value: numeric(c.conv_value), budget: numeric(c.daily_budget), shared: c.budget_shared, limited: c.limited_by_budget, channelType: c.channel_type })),
      ...(google.paused_campaigns ?? []).filter(c => !google.campaigns?.some(row => row.id === c.id)).map(c => ({ id: c.id, name: c.name, status: "PAUSED", spend: 0, conversions: 0, cpa: null, value: 0, budget: numeric(c.daily_budget), channelType: c.channel_type }))];
  const budget = kind === "meta" ? meta.meta_daily_budget : google.daily_budget;
  return { metrics, rows, readable, pacing: kind === "google" ? google.kpis?.find(k => k.key === "pacing")?.pacing ?? null : null, currency: kind === "meta" ? meta.meta_currency ?? null : google.currency ?? null, period: kind === "meta" ? meta.period : google.period, video: null as VideoTotals | null,
    ...budgetOf(budget, readable), budgetPartial: kind === "meta" && meta.meta_daily_budget?.truncated === true };
}
