import { listXAdAccountsRaw, listXCampaignRows, xAdsTenantToken, xCampaignStats, xCampaignsUrl, xLinkClicksUnread, type UserToken } from "@/services/connectors/x-ads/client";
import { AD_RANGES, addAdSums, adTotals, adWindowFor, costPer, round2, ZERO_AD_SUMS, type AdTotals } from "@/services/connectors/core/ad-metrics";
import { ExpectedToolError } from "@/services/tools/types";
import type { DashboardBuilder } from "./_contract";

const DEFAULT_DAYS = 30;
const MAX_ACCOUNTS = 5;
const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { at: number; payload: XAdsPayload }>();

export type XCampaign = {
  id: string;
  ad_account_id: string;
  currency: string | null;
  name: string;
  status: string;
  daily_budget: number | null;
  total_budget: number | null;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  engagements: number;
  link_clicks_unmeasured: boolean;
  cpa: number | null;
  url: string;
};

export type XAdsPayload = {
  platform: "x_ads";
  connected: boolean;
  error_code: string | null;
  window_days: number;
  ranges: typeof AD_RANGES;
  period: { from: string; to: string };
  prev_period: { from: string; to: string };
  account: { name: string | null; account_count: number; campaign_count: number; active_count: number; currency: string | null } | null;
  totals: AdTotals | null;
  prev_totals: AdTotals | null;
  campaigns: XCampaign[];
  engagements: number | null;
  link_clicks_unmeasured: boolean;
  daily_budget: { total_daily_budget_usd: number | null; active_campaigns: number; known_daily_budget_usd: number | null; known_campaigns: number } | null;
  conversions_unmeasured: string | null;
};

export const build: DashboardBuilder = async (c) => {
  const picked = adWindowFor(c.rangeDays ?? DEFAULT_DAYS, c.customRange);
  const { days, period, prev_period } = picked;
  const empty: XAdsPayload = {
    platform: "x_ads",
    window_days: days,
    ranges: AD_RANGES,
    period,
    prev_period,
    connected: false,
    error_code: null,
    account: null,
    totals: null,
    prev_totals: null,
    campaigns: [],
    engagements: null,
    link_clicks_unmeasured: false,
    daily_budget: null,
    conversions_unmeasured: null,
  };

  let token: UserToken;
  try {
    token = await xAdsTenantToken(c.tenantId);
  } catch (e) {
    return e instanceof ExpectedToolError && e.code === "x_ads_not_connected" ? empty : { ...empty, connected: true, error_code: "x_ads_read_failed" };
  }

  const key = `${c.tenantId}:${token.key.slice(0, 12)}:${picked.key}:${period.to}`;
  const hit = cache.get(key);
  if (hit && !c.refresh && !c.meteredRefresh && Date.now() - hit.at < CACHE_MS) return hit.payload;

  try {
    const accounts = (await listXAdAccountsRaw(token)).slice(0, MAX_ACCOUNTS);
    const perAccount = await Promise.all(
      accounts.map(async (a) => {
        const rows = (await listXCampaignRows(token, a.id)).filter((r) => r.status !== "DELETED");
        const ids = rows.filter((r) => r.status !== "DRAFT").map((r) => r.campaign_id);
        const [now, before] = await Promise.all([
          xCampaignStats(token, a.id, ids, period.from, period.to),
          xCampaignStats(token, a.id, ids, prev_period.from, prev_period.to),
        ]);
        return { a, rows, now, before };
      }),
    );
    const currencies = new Set(perAccount.flatMap(({ rows }) => rows.flatMap((r) => (r.currency ? [r.currency] : []))));
    const currency = currencies.size === 1 ? [...currencies][0] : null;

    let cur = ZERO_AD_SUMS;
    let prev = ZERO_AD_SUMS;
    const campaigns: XCampaign[] = [];
    for (const { a, rows, now, before } of perAccount) {
      for (const s of now.values()) cur = addAdSums(cur, s);
      for (const s of before.values()) prev = addAdSums(prev, s);
      for (const r of rows) {
        const s = now.get(r.campaign_id) ?? ZERO_AD_SUMS;
        campaigns.push({
          id: r.campaign_id,
          ad_account_id: a.id,
          currency: r.currency,
          name: r.name,
          status: r.status,
          daily_budget: r.daily_budget,
          total_budget: r.total_budget,
          ...s,
          engagements: now.engagements.get(r.campaign_id) ?? 0,
          link_clicks_unmeasured: xLinkClicksUnread(now, r.campaign_id),
          spend: round2(s.spend),
          cpa: costPer(s.spend, s.conversions),
          url: xCampaignsUrl(a.id),
        });
      }
    }
    campaigns.sort((x, y) => Number(y.status === "ACTIVE") - Number(x.status === "ACTIVE") || y.spend - x.spend);

    const payload: XAdsPayload = {
      ...empty,
      connected: true,
      account: {
        name: accounts.length > 1 ? `${accounts.length} ad accounts` : (accounts[0]?.name ?? null),
        account_count: accounts.length,
        campaign_count: campaigns.length,
        active_count: campaigns.filter((x) => x.status === "ACTIVE").length,
        currency,
      },
      totals: adTotals(cur, currency),
      prev_totals: adTotals(prev, currency),
      campaigns,
      engagements: campaigns.reduce((sum, x) => sum + x.engagements, 0),
      link_clicks_unmeasured: campaigns.some((x) => x.link_clicks_unmeasured),
      daily_budget: dailyBudgetTotal(campaigns, currency),
      conversions_unmeasured: perAccount.every(({ now, before }) => now.conversionsRead && before.conversionsRead)
        ? null
        : "X would not report conversions for this account",
    };
    cache.set(key, { at: Date.now(), payload });
    return payload;
  } catch (e) {
    cache.delete(key);
    return { ...empty, connected: true, error_code: e instanceof ExpectedToolError ? e.code : "x_ads_read_failed" };
  }
};

export function dailyBudgetTotal(campaigns: Array<{ status: string; daily_budget: number | null }>, currency: string | null): NonNullable<XAdsPayload["daily_budget"]> {
  const active = campaigns.filter((x) => x.status === "ACTIVE");
  const budgeted = active.filter((x) => x.daily_budget !== null);
  const sum = round2(budgeted.reduce((total, x) => total + (x.daily_budget ?? 0), 0));
  return {
    total_daily_budget_usd: currency !== null && budgeted.length === active.length ? sum : null,
    active_campaigns: active.length,
    known_daily_budget_usd: currency !== null && budgeted.length ? sum : null,
    known_campaigns: currency !== null ? budgeted.length : 0,
  };
}
