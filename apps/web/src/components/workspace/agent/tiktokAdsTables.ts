import { campaignThumbnail } from "../actions/campaigns/campaignMedia";
import { BarChart3 } from "lucide-react";
import type { ChannelMetric } from "@/lib/workspace/channelActionsApi";
import type { ExtraCell, ExtraTableData } from "../actions/ExtraTable";
import type { ChannelChrome } from "./legacyChannelActions";
import { count, DEFAULT_RANGES, roas, type GadsRange } from "./google-ads/types";
import { formatCurrency } from "../metrics/currency";
import { roasVerdict } from "../metrics/format";
import { openTiktokCampaign } from "../actions/tiktok-campaigns/openCampaign";

type TiktokTotals = {
  spend: number | null;
  impressions: number;
  clicks: number;
  conversions: number;
  conv_value: number | null;
  ctr: number | null;
  cpa: number | null;
  roas: number | null;
};

export type TiktokCampaign = {
  id: string;
  advertiser_id?: string;
  currency: string | null;
  name: string;
  status: string;
  secondary_status?: string | null;
  ad_groups?: Array<{ status: string; secondary_status?: string | null }>;
  objective?: string | null;
  daily_budget?: number | null;
  views?: number | null;
  impressions?: number;
  clicks?: number;
  spend: number;
  conversions: number;
  conv_value: number;
  cpa: number | null;
  url: string | null;
};

export type TiktokPayload = {
  platform: "tiktok_ads";
  connected: boolean;
  error_code: string | null;
  window_days: number;
  ranges?: GadsRange[];
  period?: { from: string; to: string };
  prev_period?: { from: string; to: string };
  account: { name: string | null; advertiser_count: number; campaign_count: number; currency: string | null } | null;
  totals?: (TiktokTotals & { views?: number | null }) | null;
  daily_budget?: { total_daily_budget_usd: number | null; active_campaigns: number } | null;
  prev_totals?: TiktokTotals | null;
  campaigns?: TiktokCampaign[];
};

export function isTiktokPayload(payload: unknown): payload is TiktokPayload {
  return !!payload && typeof payload === "object" && (payload as { platform?: unknown }).platform === "tiktok_ads";
}

const zeroed = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const RATIO_KEYS = new Set(["cpa", "roas", "ctr"]);

export function tiktokKpis(payload: unknown): ChannelMetric[] {
  if (!isTiktokPayload(payload) || !payload.connected || payload.error_code || !payload.totals) return [];
  const t = payload.totals;
  const currency = payload.account?.currency;
  const moneyUnit = currency === "USD" ? "usd" : `currency:${currency}`;
  const p = payload.prev_totals ?? null;
  const day = payload.period?.to ?? "";
  const prevDay = payload.prev_period?.to ?? null;
  const rows: Array<[string, keyof TiktokTotals, string]> = [
    ["spend", "spend", moneyUnit],
    ["cpa", "cpa", moneyUnit],
    ["conversions", "conversions", "count"],
    ["conv_value", "conv_value", moneyUnit],
    ["roas", "roas", "ratio"],
    ["ctr", "ctr", "pct"],
  ];
  return rows.map(([key, field, unit]) => {
    const unavailable = !currency && (unit === moneyUnit || key === "roas");
    const noRatio = !unavailable && t?.[field] == null && RATIO_KEYS.has(key);
    const value = zeroed(t?.[field]);
    const prevRaw = p ? p[field] : null;
    return {
      key,
      value: unavailable || noRatio ? Number.NaN : value,
      unit,
      window_kind: `${payload.window_days}d`,
      day,
      grounded: !unavailable && !noRatio,
      prev_value: p && !unavailable && !noRatio && prevRaw != null ? zeroed(prevRaw) : null,
      prev_day: p ? prevDay : null,
      ...(unavailable ? { unmeasured: "Totals need a single currency" } : noRatio ? { unmeasured: true as const } : {}),
      ...(key === "roas" && currency && !noRatio && zeroed(t?.spend) > 0 ? roasVerdict(value, { currency }) : {}),
    };
  });
}

export function statusCell(status: string, secondary?: string | null, groups: TiktokCampaign["ad_groups"] = []): ExtraCell {
  if (status === "ACTIVE") {
    const labels: Record<string, string> = {
      CAMPAIGN_STATUS_BUDGET_EXCEED: "Budget exceeded",
      CAMPAIGN_STATUS_ADVERTISER_BUDGET_EXCEED: "Account budget exceeded",
      CAMPAIGN_STATUS_ADVERTISER_AUDIT_DENY: "Account not approved",
      CAMPAIGN_STATUS_DELETE: "Deleted",
    };
    const ended = groups.filter((g) => g.secondary_status === "ADGROUP_STATUS_TIME_DONE").length;
    const childStatus = ended > 0
      ? ended === groups.length ? "Ended" : `Enabled · ${ended}/${groups.length} ad groups ended`
      : groups.length > 0 && groups.every((g) => g.status === "PAUSED") ? "Ad groups paused" : "Enabled";
    const text = secondary && secondary !== "CAMPAIGN_STATUS_ENABLE"
      ? labels[secondary] ?? secondary.replace(/^CAMPAIGN_STATUS_/, "").toLowerCase().replace(/_/g, " ")
      : childStatus;
    return { text, chip: "muted" };
  }
  const label = status ? status.charAt(0) + status.slice(1).toLowerCase() : "Unknown";
  return { text: label, chip: "muted" };
}

export function tiktokCampaignTable(payload: unknown): ExtraTableData[] {
  if (!isTiktokPayload(payload) || !payload.connected || payload.error_code || !payload.totals) return [];
  const rows = payload.campaigns ?? [];
  const t = payload.totals;
  const currency = payload.account?.currency;
  return [
    {
      title: "Campaign performance",
      icon: BarChart3,
      columns: [
        { label: "Campaign", align: "left" },
        { label: "Status", align: "left" },
        { label: "Spend" },
        { label: "Conv." },
        { label: "CPA" },
        { label: "Conv. value" },
      ],
      rows: rows.map((c) => ({
        id: c.id,
        actions: c.advertiser_id ? [{ label: "Edit campaign", onClick: () => openTiktokCampaign({ advertiser_id: c.advertiser_id!, campaign_id: c.id }) }] : [],
        cells: [
          { text: c.name, href: c.url, media: campaignThumbnail("tiktok_ads", c, c.id, c.name, rows.map((campaign) => campaign.id).join(",")) },
          statusCell(c.status, c.secondary_status, c.ad_groups),
          { text: formatCurrency(c.spend, c.currency), strong: true },
          { text: count(c.conversions) },
          { text: formatCurrency(c.cpa, c.currency, true) },
          { text: formatCurrency(c.conv_value, c.currency) },
        ],
      })),
      footer: [
        { text: `${rows.length} ${rows.length === 1 ? "campaign" : "campaigns"}` },
        { text: `ROAS ${roas(currency ? t?.roas : null)}`, tone: "dim" },
        { text: formatCurrency(t?.spend, currency) },
        { text: count(zeroed(t?.conversions)) },
        { text: formatCurrency(currency ? t?.cpa : null, currency, true) },
        { text: formatCurrency(t?.conv_value, currency) },
      ],
      empty: "No TikTok campaign ran in this period.",
      caption: currency ? "Numbers as reported by TikTok Ads." : "Campaign amounts use each advertiser's currency. Monetary totals require a single known currency.",
    },
  ];
}

export function tiktokChrome(payload: unknown): ChannelChrome | null {
  if (!isTiktokPayload(payload) || typeof payload.connected !== "boolean") return null;
  const a = payload.account;
  const n = a?.campaign_count ?? 0;
  return {
    connected: payload.connected,
    ranges: payload.ranges?.length ? payload.ranges : DEFAULT_RANGES,
    period: payload.period ?? null,
    account: a ? { name: a.name, sub: `${n} ${n === 1 ? "campaign" : "campaigns"}` } : null,
    problem:
      payload.error_code === "tiktok_ads_token_revoked"
        ? {
            text: "TikTok Ads stopped accepting Zavi's access, so these numbers could not be read. Reconnect to bring them back.",
            reconnect: true,
          }
        : payload.error_code === "tiktok_ads_rate_limited"
          ? { text: "TikTok Ads is limiting requests. Wait a minute, then try Refresh.", reconnect: false }
        : payload.error_code
          ? { text: "Zavi could not read your TikTok Ads account just now. Try Refresh in a minute.", reconnect: false }
          : null,
    plan: null,
  };
}

export function tiktokCampaignLinks(payload: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isTiktokPayload(payload)) return out;
  for (const c of payload.campaigns ?? []) if (c.name && c.url) out[c.name] = c.url;
  return out;
}
