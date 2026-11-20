import { adWindowFor } from "@/services/connectors/core/ad-metrics";
import type { OwnedComposioAccount } from "@/services/connectors/composio/api";
import { resolveOwnedComposioAccount } from "@/services/connectors/composio/account";
import {
  addSums,
  campaignDailyBudget,
  campaignReport,
  listAdAccounts,
  listAdGroups,
  listCampaigns,
  redditCampaignsUrl,
  ZERO_SUMS,
  type RedditSums,
} from "@/services/connectors/reddit-ads/composio-read";
import { ExpectedToolError } from "@/services/tools/types";
import type { DashboardBuilder } from "./_contract";

export const REDDIT_RANGES = [
  { id: "7d", label: "Last 7 days", days: 7 },
  { id: "14d", label: "Last 14 days", days: 14 },
  { id: "30d", label: "Last 30 days", days: 30 },
] as const;
const DEFAULT_DAYS = 30;
const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { at: number; payload: RedditAdsPayload }>();

export type RedditTotals = {
  spend: number | null;
  impressions: number;
  clicks: number;
  conversions: number;
  ctr: number | null;
  cpc: number | null;
  cpa: number | null;
};

export type RedditCampaign = {
  id: string;
  ad_account_id: string;
  currency: string | null;
  name: string;
  status: string;
  daily_budget: number | null;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  conversions: number | null;
  cpa: number | null;
  url: string;
};

export type RedditAdsPayload = {
  platform: "reddit_ads";
  connected: boolean;
  error_code: string | null;
  window_days: number;
  ranges: typeof REDDIT_RANGES;
  period: { from: string; to: string };
  prev_period: { from: string; to: string };
  account: { name: string | null; account_count: number; campaign_count: number; active_count: number; currency: string | null } | null;
  totals: RedditTotals | null;
  prev_totals: RedditTotals | null;
  campaigns: RedditCampaign[];
  daily_budget: { total_daily_budget_usd: number | null; active_campaigns: number; known_daily_budget_usd: number | null; known_campaigns: number } | null;
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const HIDDEN = new Set(["DELETED", "ARCHIVED"]);

export function deliveryStatus(configured: string, effective: string | null | undefined): string {
  if (configured !== "ACTIVE" || !effective || effective === "ACTIVE") return configured;
  return effective;
}

export function redditTotals(s: RedditSums): RedditTotals {
  return {
    spend: round2(s.spend),
    impressions: s.impressions,
    clicks: s.clicks,
    conversions: s.conversions,
    ctr: s.impressions > 0 ? round2((s.clicks / s.impressions) * 100) : null,
    cpc: s.clicks > 0 ? round2(s.spend / s.clicks) : null,
    cpa: s.conversions > 0 ? round2(s.spend / s.conversions) : null,
  };
}

function currencyTotals(sums: RedditSums, currency: string | null): RedditTotals {
  const totals = redditTotals(sums);
  return currency ? totals : { ...totals, spend: null, cpc: null, cpa: null };
}

function dailyBudgetTotal(campaigns: RedditCampaign[], currency: string | null): RedditAdsPayload["daily_budget"] {
  const active = campaigns.filter((x) => x.status === "ACTIVE");
  const known = currency !== null && active.every((x) => x.daily_budget !== null);
  const budgeted = active.filter((x) => x.daily_budget !== null);
  return {
    total_daily_budget_usd: known ? round2(active.reduce((sum, x) => sum + (x.daily_budget ?? 0), 0)) : null,
    active_campaigns: active.length,
    known_daily_budget_usd: currency !== null && budgeted.length ? round2(budgeted.reduce((sum, x) => sum + (x.daily_budget ?? 0), 0)) : null,
    known_campaigns: currency !== null ? budgeted.length : 0,
  };
}

export const build: DashboardBuilder = async (c) => {
  const picked = adWindowFor(c.rangeDays ?? DEFAULT_DAYS, c.customRange);
  const { days, period, prev_period } = picked;
  const base = { platform: "reddit_ads" as const, window_days: days, ranges: REDDIT_RANGES, period, prev_period };
  const empty: RedditAdsPayload = {
    ...base,
    connected: false,
    error_code: null,
    account: null,
    totals: null,
    prev_totals: null,
    campaigns: [],
    daily_budget: null,
  };

  let account: OwnedComposioAccount | null = null;
  try {
    account = await resolveOwnedComposioAccount(c.tenantId, "reddit_ads");
  } catch {
    return { ...empty, connected: true, error_code: "reddit_ads_read_failed" };
  }
  if (!account) return empty;

  const key = `${c.tenantId}:${account.connected_account_id}:${account.auth_config_id}:${picked.key}:${period.to}`;
  const hit = cache.get(key);
  if (hit && !c.refresh && !c.meteredRefresh && Date.now() - hit.at < CACHE_MS) return hit.payload;

  try {
    const accounts = await listAdAccounts(account);
    const perAccount = await Promise.all(
      accounts.map((a) =>
        Promise.all([
          listCampaigns(account, a.id),
          listAdGroups(account, a.id).catch(() => null),
          campaignReport(account, a.id, period.from, period.to),
          campaignReport(account, a.id, prev_period.from, prev_period.to),
        ]).then(([rows, groups, now, before]) => ({ a, rows, groups, now, before })),
      ),
    );
    const firstCurrency = accounts[0]?.currency ?? null;
    const currency = firstCurrency && accounts.every((a) => a.currency === firstCurrency) ? firstCurrency : null;

    let cur = ZERO_SUMS;
    let prev = ZERO_SUMS;
    const campaigns: RedditCampaign[] = [];
    for (const { a, rows, groups, now, before } of perAccount) {
      for (const s of now.values()) cur = addSums(cur, currency ? s : { ...s, spend: 0 });
      for (const s of before.values()) prev = addSums(prev, currency ? s : { ...s, spend: 0 });
      for (const r of rows) {
        if (HIDDEN.has(r.status)) continue;
        const s = now.get(r.campaign_id);
        campaigns.push({
          id: r.campaign_id,
          ad_account_id: a.id,
          currency: a.currency,
          name: r.name,
          status: deliveryStatus(r.status, r.effective_status),
          daily_budget: campaignDailyBudget(r, groups),
          spend: s ? round2(s.spend) : null,
          impressions: s ? s.impressions : null,
          clicks: s ? s.clicks : null,
          conversions: s ? s.conversions : null,
          cpa: s && s.conversions > 0 ? round2(s.spend / s.conversions) : null,
          url: redditCampaignsUrl(a.id),
        });
      }
    }
    campaigns.sort((x, y) => Number(y.status === "ACTIVE") - Number(x.status === "ACTIVE") || (y.spend ?? 0) - (x.spend ?? 0));

    const payload: RedditAdsPayload = {
      ...base,
      connected: true,
      error_code: null,
      account: {
        name: accounts.length > 1 ? `${accounts.length} ad accounts` : (accounts[0]?.name ?? null),
        account_count: accounts.length,
        campaign_count: campaigns.length,
        active_count: campaigns.filter((x) => x.status === "ACTIVE").length,
        currency,
      },
      totals: currencyTotals(cur, currency),
      prev_totals: currencyTotals(prev, currency),
      campaigns,
      daily_budget: dailyBudgetTotal(campaigns, currency),
    };
    cache.set(key, { at: Date.now(), payload });
    return payload;
  } catch (e) {
    cache.delete(key);
    return { ...empty, connected: true, error_code: e instanceof ExpectedToolError ? e.code : "reddit_ads_read_failed" };
  }
};
