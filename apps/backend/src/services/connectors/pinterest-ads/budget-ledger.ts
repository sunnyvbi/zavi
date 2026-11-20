
import { getConnectorToken } from "@/services/connectors/core/token";
import type { AccountRead, LedgerCampaign } from "@/services/decisions/ad-budget-reconcile";
import { DailySpend, dayChunks, ledgerConnected, onOffStatus, requireUsd, spendAmount, zoneDate } from "@/services/connectors/core/budget-ledger";
import { PINTEREST_ADS_ACCESS_TOKEN_KEY, PINTEREST_ADS_SLUG } from "./constants";
import { pinterestAdsGet, pinterestCollect } from "./http";

const LABEL = "Pinterest Ads";
const MICROS = 1_000_000;
const ANALYTICS_MAX_DAYS = 90;
const LIST_LIMIT = 4000;
const STATUSES = ["ACTIVE", "PAUSED", "ARCHIVED"];

type Account = { id: string; currency?: string | null; time_zone?: string | null };
type Campaign = {
  id: string; name?: string | null; status?: string | null;
  daily_spend_cap?: number | null; lifetime_spend_cap?: number | null; is_campaign_budget_optimization?: boolean | null;
};
type AdGroup = {
  id: string; name?: string | null; status?: string | null; campaign_id?: string | null;
  budget_in_micro_currency?: number | null; budget_type?: string | null;
};
type AnalyticsRow = { DATE?: string; SPEND_IN_MICRO_DOLLAR?: number | string | null };

function statusOf(s: string | null | undefined): string | null {
  return onOffStatus(s === "ACTIVE" ? true : s === "PAUSED" ? false : null, s);
}

async function list<T>(token: string, path: string): Promise<T[]> {
  const params = new URLSearchParams();
  for (const s of STATUSES) params.append("entity_statuses", s);
  params.set("page_size", "250");
  const rows = await pinterestCollect<T>(token, path, params, LIST_LIMIT);
  if (rows.length >= LIST_LIMIT) throw new Error(`${LABEL} has more objects than one read covers; spend is unknown.`);
  return rows;
}

export async function readPinterestAccountsForBudget(tenantId: string, start: Date, now = new Date()): Promise<AccountRead[]> {
  if (!(await ledgerConnected(tenantId, PINTEREST_ADS_SLUG, LABEL))) return [];
  const token = await getConnectorToken(tenantId, PINTEREST_ADS_SLUG, PINTEREST_ADS_ACCESS_TOKEN_KEY);
  if (!token) throw new Error(`${LABEL} is connected but its token is missing; reconnect it.`);
  const accounts = await pinterestCollect<Account>(token, "ad_accounts", new URLSearchParams({ page_size: "250" }), LIST_LIMIT);
  requireUsd(LABEL, accounts.map((a) => a.currency));
  const reads: AccountRead[] = [];
  for (const acct of accounts) {
    const window = { since: start.toISOString().slice(0, 10), until: zoneDate(now, acct.time_zone) };
    const campaigns = await list<Campaign>(token, `ad_accounts/${acct.id}/campaigns`);
    const adGroups = await list<AdGroup>(token, `ad_accounts/${acct.id}/ad_groups`);
    const objects: LedgerCampaign[] = [];
    for (const c of campaigns) {
      const daily = c.daily_spend_cap ? c.daily_spend_cap / MICROS : null;
      const lifetime = c.lifetime_spend_cap ? c.lifetime_spend_cap / MICROS : null;
      if (!c.is_campaign_budget_optimization && !daily && !lifetime) continue;
      objects.push({
        object_id: c.id, level: "campaign", campaign_id: c.id, name: c.name ?? null,
        budget_kind: daily ? "daily" : lifetime ? "lifetime" : "none", budget_usd: daily ?? lifetime,
        status: statusOf(c.status), currency: acct.currency ?? "UNKNOWN",
      });
    }
    const cboCampaigns = new Set(campaigns.filter((c) => c.is_campaign_budget_optimization).map((c) => c.id));
    for (const g of adGroups) {
      const amount = g.budget_in_micro_currency ? g.budget_in_micro_currency / MICROS : null;
      const underCbo = g.budget_type === "CBO_ADGROUP" || (!!g.campaign_id && cboCampaigns.has(g.campaign_id));
      objects.push({
        object_id: g.id, level: "ad_group", campaign_id: g.campaign_id ?? null, name: g.name ?? null,
        budget_kind: underCbo ? "campaign_level" : amount == null ? "none" : g.budget_type === "LIFETIME" ? "lifetime" : "daily",
        budget_usd: underCbo ? null : amount,
        status: statusOf(g.status), currency: acct.currency ?? "UNKNOWN",
      });
    }
    const spend = new DailySpend();
    if (window.since <= window.until)
      for (const chunk of dayChunks(window.since, window.until, ANALYTICS_MAX_DAYS)) {
        const rows = await pinterestAdsGet<AnalyticsRow[]>(token, `ad_accounts/${acct.id}/analytics`, new URLSearchParams({
          start_date: chunk.since, end_date: chunk.until, columns: "SPEND_IN_MICRO_DOLLAR", granularity: "DAY",
        }));
        if (!Array.isArray(rows)) throw new Error(`${LABEL} analytics returned no rows array; spend is unknown.`);
        for (const r of rows) {
          const day = typeof r.DATE === "string" ? r.DATE.slice(0, 10) : "";
          if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`${LABEL} analytics row has no date; spend is unknown.`);
          if (r.SPEND_IN_MICRO_DOLLAR == null) continue;
          spend.add(`account_${acct.id}`, day, spendAmount(LABEL, r.SPEND_IN_MICRO_DOLLAR, MICROS));
        }
      }
    reads.push({ platform: "pinterest", account_id: acct.id, window, campaigns: objects, spend: spend.toRows(window.until, 2) });
  }
  return reads;
}
