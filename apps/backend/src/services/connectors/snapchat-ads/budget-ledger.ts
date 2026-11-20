
import { getConnectorToken } from "@/services/connectors/core/token";
import type { AccountRead } from "@/services/decisions/ad-budget-reconcile";
import { DailySpend, addDays, dayChunks, ledgerConnected, onOffStatus, requireUsd, spendAmount, zoneDate, zoneOffset } from "@/services/connectors/core/budget-ledger";
import { SNAPCHAT_ADS_ACCESS_TOKEN_KEY, SNAPCHAT_ADS_SLUG } from "./constants";
import { snapchatCollection } from "./http";

const LABEL = "Snapchat Ads";
const MICROS = 1_000_000;
const STATS_MAX_DAYS = 31;
const LIST_LIMIT = 4000;

type Org = { id: string };
type Account = { id: string; currency?: string | null; timezone?: string | null };
type Squad = {
  id: string; name?: string | null; status?: string | null; campaign_id?: string | null;
  daily_budget_micro?: number | string | null; lifetime_budget_micro?: number | string | null;
};
type Timeseries = { timeseries?: Array<{ start_time?: string; stats?: { spend?: number | string | null } }> };

async function accountsOf(token: string): Promise<Account[]> {
  const orgs = await snapchatCollection<Org>(token, "me/organizations", "organizations", "organization", {}, 500, true);
  const byId = new Map<string, Account>();
  for (const org of orgs)
    for (const a of await snapchatCollection<Account>(token, `organizations/${encodeURIComponent(org.id)}/adaccounts`, "adaccounts", "adaccount", {}, 500, true))
      byId.set(a.id, a);
  return [...byId.values()];
}

const micros = (v: number | string | null | undefined) => (v == null || v === "" ? null : Number(v) > 0 ? Number(v) / MICROS : null);

export async function readSnapchatAccountsForBudget(tenantId: string, start: Date, now = new Date()): Promise<AccountRead[]> {
  if (!(await ledgerConnected(tenantId, SNAPCHAT_ADS_SLUG, LABEL))) return [];
  const token = await getConnectorToken(tenantId, SNAPCHAT_ADS_SLUG, SNAPCHAT_ADS_ACCESS_TOKEN_KEY);
  if (!token) throw new Error(`${LABEL} is connected but its token is missing; reconnect it.`);
  const accounts = await accountsOf(token);
  requireUsd(LABEL, accounts.map((a) => a.currency));
  const reads: AccountRead[] = [];
  for (const acct of accounts) {
    const window = { since: start.toISOString().slice(0, 10), until: zoneDate(now, acct.timezone) };
    const squads = await snapchatCollection<Squad>(token, `adaccounts/${encodeURIComponent(acct.id)}/adsquads`, "adsquads", "adsquad", { limit: "200" }, LIST_LIMIT, true);
    if (squads.length >= LIST_LIMIT) throw new Error(`${LABEL} has more ad squads than one read covers; spend is unknown.`);
    const spend = new DailySpend();
    if (window.since <= window.until)
      for (const chunk of dayChunks(window.since, window.until, STATS_MAX_DAYS)) {
        const end = addDays(chunk.until, 1);
        const series = await snapchatCollection<Timeseries>(token, `adaccounts/${encodeURIComponent(acct.id)}/stats`, "timeseries_stats", "timeseries_stat", {
          granularity: "DAY",
          fields: "spend",
          start_time: `${chunk.since}T00:00:00${zoneOffset(chunk.since, acct.timezone)}`,
          end_time: `${end}T00:00:00${zoneOffset(end, acct.timezone)}`,
        }, 500, true);
        if (series.length === 0) throw new Error(`${LABEL} returned no stats; spend is unknown.`);
        for (const s of series)
          for (const t of s.timeseries ?? []) {
            if (!t.start_time) throw new Error(`${LABEL} stats window has no start; spend is unknown.`);
            const day = zoneDate(new Date(t.start_time), acct.timezone);
            if (t.stats?.spend == null) continue;
            spend.add(`account_${acct.id}`, day, spendAmount(LABEL, t.stats.spend, MICROS));
          }
      }
    reads.push({
      platform: "snapchat",
      account_id: acct.id,
      window,
      campaigns: squads.map((q) => {
        const daily = micros(q.daily_budget_micro);
        const lifetime = micros(q.lifetime_budget_micro);
        return {
          object_id: q.id, level: "ad_set" as const, campaign_id: q.campaign_id ?? null, name: q.name ?? null,
          budget_kind: daily ? ("daily" as const) : lifetime ? ("lifetime" as const) : ("none" as const),
          budget_usd: daily ?? lifetime,
          status: onOffStatus(q.status === "ACTIVE" ? true : q.status === "PAUSED" ? false : null, q.status),
          currency: acct.currency ?? "UNKNOWN",
        };
      }),
      spend: spend.toRows(window.until, 2),
    });
  }
  return reads;
}
