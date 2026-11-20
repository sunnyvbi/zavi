import { adWindowFor } from "@/services/connectors/core/ad-metrics";
import type { OwnedComposioAccount } from "@/services/connectors/composio/api";
import { resolveOwnedComposioAccount } from "@/services/connectors/composio/account";
import {
  addSums,
  campaignReport,
  viewsReport,
  listAdvertisers,
  listCampaigns,
  tiktokCampaignsUrl,
  ZERO_SUMS,
  type TiktokSums,
} from "@/services/connectors/tiktok-ads/composio-read";
import { ExpectedToolError } from "@/services/tools/types";
import { ensureAdAccounts } from "@/services/connectors/tiktok-ads/ad-accounts";
import { isDailyMode, listTiktokAdGroups, type TiktokObject } from "@/services/connectors/tiktok-ads/objects";
import type { DashboardBuilder } from "./_contract";

export const TIKTOK_RANGES = [
  { id: "7d", label: "Last 7 days", days: 7 },
  { id: "14d", label: "Last 14 days", days: 14 },
  { id: "30d", label: "Last 30 days", days: 30 },
] as const;
const DEFAULT_DAYS = 30;
const CACHE_MS = 5 * 60_000;
const MAX_DASHBOARD_ADVERTISERS = 10;
const cache = new Map<string, { at: number; payload: TiktokAdsPayload }>();

export type TiktokTotals = {
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
  advertiser_id: string;
  currency: string | null;
  name: string;
  status: string;
  secondary_status: string | null;
  objective: string | null;
  daily_budget: number | null;
  ad_groups: TiktokObject[];
  views: number | null;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conv_value: number;
  cpa: number | null;
  url: string;
};

export type TiktokAdsPayload = {
  platform: "tiktok_ads";
  connected: boolean;
  error_code: string | null;
  window_days: number;
  ranges: typeof TIKTOK_RANGES;
  period: { from: string; to: string };
  prev_period: { from: string; to: string };
  account: { name: string | null; advertiser_count: number; campaign_count: number; currency: string | null } | null;
  totals: (TiktokTotals & { views?: number | null }) | null;
  prev_totals: TiktokTotals | null;
  daily_budget: { total_daily_budget_usd: number | null; active_campaigns: number; known_daily_budget_usd: number | null; known_campaigns: number } | null;
  campaigns: TiktokCampaign[];
};

type Sums = TiktokSums;
const ZERO = ZERO_SUMS;
const round2 = (n: number) => Math.round(n * 100) / 100;

export function tiktokTotals(s: Sums): TiktokTotals {
  return {
    spend: round2(s.spend),
    impressions: s.impressions,
    clicks: s.clicks,
    conversions: s.conversions,
    conv_value: round2(s.conv_value),
    ctr: s.impressions > 0 ? round2((s.clicks / s.impressions) * 100) : null,
    cpa: s.conversions > 0 ? round2(s.spend / s.conversions) : null,
    roas: s.spend > 0 ? round2(s.conv_value / s.spend) : null,
  };
}

export const build: DashboardBuilder = async (c) => {
  const picked = adWindowFor(c.rangeDays ?? DEFAULT_DAYS, c.customRange);
  const { days, period, prev_period } = picked;
  const base = {
    platform: "tiktok_ads" as const,
    window_days: days,
    ranges: TIKTOK_RANGES,
    period,
    prev_period,
  };
  const empty: TiktokAdsPayload = {
    ...base,
    connected: false,
    error_code: null,
    account: null,
    totals: null,
    prev_totals: null,
    daily_budget: null,
    campaigns: [],
  };

  let account: OwnedComposioAccount | null = null;
  try {
    account = await resolveOwnedComposioAccount(c.tenantId, "tiktok_ads");
  } catch {
    return { ...empty, connected: true, error_code: "tiktok_ads_read_failed" };
  }
  if (!account) return empty;

  const key = `${c.tenantId}:${account.connected_account_id}:${account.auth_config_id}:${picked.key}:${period.to}`;
  const hit = cache.get(key);
  if (hit && !c.refresh && !c.meteredRefresh && Date.now() - hit.at < CACHE_MS) return hit.payload;

  try {
    const saved = await ensureAdAccounts(c.tenantId);
    const ids = [
      ...saved.accounts.filter((a) => a.advertiser_id === saved.selected_id),
      ...saved.accounts.filter((a) => a.advertiser_id !== saved.selected_id),
    ].map((a) => a.advertiser_id).slice(0, MAX_DASHBOARD_ADVERTISERS);
    const [advertisers, perAdvertiser] = await Promise.all([
      listAdvertisers(account, ids),
      Promise.all(
        ids.map((adv) =>
          Promise.all([
            listCampaigns(account, adv),
            listTiktokAdGroups(account, adv),
            viewsReport(account, adv, "campaign", period.from, period.to),
            campaignReport(account, adv, prev_period.from, prev_period.to),
          ]).then(([rows, groups, now, before]) => ({ adv, rows, groups, now, before })),
        ),
      ),
    ]);
    const name = advertisers[0]?.name ?? null;
    const currencies = new Map(advertisers.map((a) => [a.advertiser_id, a.currency?.trim().toUpperCase() || null]));
    const firstCurrency = currencies.get(ids[0]) ?? null;
    const currency = firstCurrency && ids.every((id) => currencies.get(id) === firstCurrency) ? firstCurrency : null;

    let cur = ZERO;
    let prev = ZERO;
    let views: number | null = 0;
    const campaigns: TiktokCampaign[] = [];
    for (const { adv, rows, groups, now, before } of perAdvertiser) {
      for (const s of now.values()) {
        cur = addSums(cur, currency ? s : { ...s, spend: 0, conv_value: 0 });
        views = views === null || s.views === null ? null : views + s.views;
      }
      for (const s of before.values()) prev = addSums(prev, currency ? s : { ...s, spend: 0, conv_value: 0 });
      for (const r of rows) {
        if (r.status === "DELETED") continue;
        const s = now.get(r.campaign_id) ?? { ...ZERO, views: 0 };
        const children = groups.filter((g) => g.campaign_id === r.campaign_id && g.status !== "DELETED");
        campaigns.push({
          id: r.campaign_id,
          advertiser_id: adv,
          currency: currencies.get(adv) ?? null,
          name: r.name,
          status: r.status,
          secondary_status: r.secondary_status,
          objective: r.objective,
          daily_budget: campaignDailyBudget(r.budget, r.budget_mode, children),
          ad_groups: children,
          views: s.views,
          spend: round2(s.spend),
          impressions: s.impressions,
          clicks: s.clicks,
          conversions: s.conversions,
          conv_value: round2(s.conv_value),
          cpa: s.conversions > 0 ? round2(s.spend / s.conversions) : null,
          url: tiktokCampaignsUrl(adv),
        });
      }
    }
    campaigns.sort((a, b) => (a.currency ?? "").localeCompare(b.currency ?? "") || b.spend - a.spend);

    const payload: TiktokAdsPayload = {
      ...base,
      connected: true,
      error_code: null,
      account: {
        name: ids.length > 1 ? `${ids.length} advertisers` : name,
        advertiser_count: ids.length,
        campaign_count: campaigns.length,
        currency,
      },
      totals: { ...currencyTotals(cur, currency), views },
      prev_totals: currencyTotals(prev, currency),
      daily_budget: accountDailyBudget(campaigns, currency),
      campaigns,
    };
    cache.set(key, { at: Date.now(), payload });
    return payload;
  } catch (e) {
    cache.delete(key);
    return {
      ...empty,
      connected: true,
      error_code: e instanceof ExpectedToolError ? e.code : "tiktok_ads_read_failed",
    };
  }
};

function currencyTotals(sums: Sums, currency: string | null): TiktokTotals {
  const totals = tiktokTotals(sums);
  return currency ? totals : { ...totals, spend: null, conv_value: null, cpa: null, roas: null };
}

function campaignDailyBudget(budget: number | null, mode: string | null, groups: TiktokObject[]): number | null {
  if (isDailyMode(mode) && budget !== null && budget > 0) return budget;
  const live = groups.filter((g) => g.status === "ACTIVE");
  if (!live.length || live.some((g) => !isDailyMode(g.budget_mode) || g.budget === null)) return null;
  return round2(live.reduce((sum, g) => sum + (g.budget ?? 0), 0));
}

function accountDailyBudget(campaigns: TiktokCampaign[], currency: string | null): NonNullable<TiktokAdsPayload["daily_budget"]> {
  const active = campaigns.filter((c) => c.status === "ACTIVE");
  const known = currency !== null && active.every((c) => c.daily_budget !== null);
  const budgeted = active.filter((c) => c.daily_budget !== null);
  return {
    total_daily_budget_usd: known ? round2(active.reduce((sum, c) => sum + (c.daily_budget ?? 0), 0)) : null,
    active_campaigns: active.length,
    known_daily_budget_usd: currency !== null && budgeted.length ? round2(budgeted.reduce((sum, c) => sum + (c.daily_budget ?? 0), 0)) : null,
    known_campaigns: currency !== null ? budgeted.length : 0,
  };
}
