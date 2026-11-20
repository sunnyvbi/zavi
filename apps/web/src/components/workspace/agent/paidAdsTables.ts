import { campaignThumbnail } from "../actions/campaigns/campaignMedia";
import { BarChart3 } from "lucide-react";
import type { ChannelMetric } from "@/lib/workspace/channelActionsApi";
import type { ExtraCell, ExtraColumn, ExtraTableData } from "../actions/ExtraTable";
import type { ChannelChrome } from "./legacyChannelActions";
import { count, DEFAULT_RANGES, type GadsRange } from "./google-ads/types";
import { formatCurrency } from "../metrics/currency";

export type PaidAdsTotals = {
  spend: number | null;
  impressions: number;
  clicks: number;
  conversions: number;
  ctr: number | null;
  cpc: number | null;
  cpa: number | null;
};

export type PaidAdsCampaign = {
  id: string;
  currency: string | null;
  name: string;
  status: string;
  spend: number | null;
  clicks: number | null;
  conversions: number | null;
  cpa: number | null;
  url: string | null;
  daily_budget?: number | null;
};

export type PaidAdsPayload<P extends string> = {
  platform: P;
  connected: boolean;
  error_code: string | null;
  window_days: number;
  ranges?: GadsRange[];
  period?: { from: string; to: string };
  prev_period?: { from: string; to: string };
  account: { name: string | null; account_count: number; campaign_count: number; active_count: number; currency: string | null } | null;
  totals?: PaidAdsTotals | null;
  prev_totals?: PaidAdsTotals | null;
  campaigns?: PaidAdsCampaign[];
  conversions_unmeasured?: string | null;
};

export type PaidAdsSpec<P extends string> = {
  platform: P;
  brand: string;
  budgetColumn?: boolean;
  problem: (code: string) => { text: string; reconnect: boolean };
};

const zeroed = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const RATIO_KEYS = new Set(["cpa", "cpc", "ctr"]);

function statusCell(status: string): ExtraCell {
  if (status === "ACTIVE") return { text: "Active", chip: "good" };
  const label = status ? (status.charAt(0) + status.slice(1).toLowerCase()).replace(/_/g, " ") : "Unknown";
  return { text: label, chip: "muted" };
}

export function paidAdsAdapter<P extends string>(spec: PaidAdsSpec<P>) {
  type Payload = PaidAdsPayload<P>;
  const is = (payload: unknown): payload is Payload =>
    !!payload && typeof payload === "object" && (payload as { platform?: unknown }).platform === spec.platform;
  const readable = (payload: unknown): payload is Payload & { totals: PaidAdsTotals } =>
    is(payload) && payload.connected && !payload.error_code && !!payload.totals;

  function kpis(payload: unknown): ChannelMetric[] {
    if (!readable(payload)) return [];
    const t = payload.totals;
    const currency = payload.account?.currency;
    const moneyUnit = currency === "USD" ? "usd" : `currency:${currency}`;
    const p = payload.prev_totals ?? null;
    const day = payload.period?.to ?? "";
    const prevDay = payload.prev_period?.to ?? null;
    const rows: Array<[keyof PaidAdsTotals, string]> = [
      ["spend", moneyUnit],
      ["cpa", moneyUnit],
      ["conversions", "count"],
      ["clicks", "count"],
      ["ctr", "pct"],
      ["cpc", moneyUnit],
    ];
    return rows.map(([key, unit]) => {
      const noConv = (key === "cpa" || key === "conversions") && payload.conversions_unmeasured ? payload.conversions_unmeasured : undefined;
      const unavailable = !currency && unit === moneyUnit;
      const noRatio = noConv ?? (!unavailable && t[key] == null && RATIO_KEYS.has(key) ? (true as const) : undefined);
      const prevRaw = p ? p[key] : null;
      return {
        key,
        value: unavailable || noRatio ? Number.NaN : zeroed(t[key]),
        unit,
        window_kind: `${payload.window_days}d`,
        day,
        grounded: !unavailable && !noRatio,
        prev_value: p && !unavailable && !noRatio && prevRaw != null ? zeroed(prevRaw) : null,
        prev_day: p ? prevDay : null,
        ...(unavailable ? { unmeasured: "Totals need a single currency" } : noRatio ? { unmeasured: noRatio } : {}),
      };
    });
  }

  function campaignTable(payload: unknown): ExtraTableData[] {
    if (!readable(payload)) return [];
    const rows = payload.campaigns ?? [];
    const t = payload.totals;
    const currency = payload.account?.currency;
    const active = payload.account?.active_count ?? rows.filter((c) => c.status === "ACTIVE").length;
    const budget = !!spec.budgetColumn;
    const noConv = !!payload.conversions_unmeasured;
    const columns: ExtraColumn[] = [
      { label: "Campaign", align: "left" },
      { label: "Status", align: "left" },
      ...(budget ? [{ label: "Daily budget" }] : []),
      { label: "Spend" },
      { label: "Clicks" },
      { label: "Conv." },
      { label: "CPA" },
    ];
    return [
      {
        title: "Campaigns",
        icon: BarChart3,
        columns,
        rows: rows.map((c) => ({
          id: c.id,
          cells: [
            { text: c.name, href: c.url, media: campaignThumbnail(spec.platform, c, c.id, c.name, rows.map((campaign) => campaign.id).join(",")) },
            statusCell(c.status),
            ...(budget ? [{ text: formatCurrency(c.daily_budget, c.currency) }] : []),
            { text: formatCurrency(c.spend, c.currency), strong: true },
            { text: count(c.clicks) },
            { text: noConv ? "-" : count(c.conversions) },
            { text: noConv ? "-" : formatCurrency(c.cpa, c.currency, true) },
          ],
        })),
        footer: [
          { text: `${active} active of ${rows.length}` },
          { text: "" },
          ...(budget ? [{ text: "" }] : []),
          { text: formatCurrency(t.spend, currency) },
          { text: count(zeroed(t.clicks)) },
          { text: noConv ? "-" : count(zeroed(t.conversions)) },
          { text: noConv ? "-" : formatCurrency(currency ? t.cpa : null, currency, true) },
        ],
        empty: `No ${spec.brand} campaign in this account yet.`,
        caption: currency
          ? `Numbers as reported by ${spec.brand} Ads.${rows.some((c) => c.spend == null) ? ` "-" means ${spec.brand} has reported nothing for that campaign in this period yet.` : ""}`
          : "Campaign amounts use each ad account's currency. Monetary totals require a single known currency.",
      },
    ];
  }

  function chrome(payload: unknown): ChannelChrome | null {
    if (!is(payload) || typeof payload.connected !== "boolean") return null;
    const a = payload.account;
    const n = a?.active_count ?? 0;
    return {
      connected: payload.connected,
      ranges: payload.ranges?.length ? payload.ranges : DEFAULT_RANGES,
      period: payload.period ?? null,
      account: a ? { name: a.name, sub: `${n} active ${n === 1 ? "campaign" : "campaigns"}` } : null,
      problem: payload.error_code ? spec.problem(payload.error_code) : null,
      plan: null,
    };
  }

  function campaignLinks(payload: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    if (!is(payload)) return out;
    for (const c of payload.campaigns ?? []) if (c.name && c.url) out[c.name] = c.url;
    return out;
  }

  return { is, kpis, campaignTable, chrome, campaignLinks };
}
