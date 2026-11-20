import { composioConnectionStoppedError, resolveOwnedComposioAccount } from "@/services/connectors/composio/account";
import { ConnectionUnknownError } from "@/services/connectors/core/budget-ledger";
import { dateInZone, rememberAccountZone } from "@/services/growth/account-zone";
import { listAdAccounts } from "./composio-read";
import { listObjects, ownedAccount } from "./adapter";
import { metric, reportRows } from "./reporting";
import type { AccountRead } from "@/services/decisions/ad-budget-reconcile";
import type { RedditObject } from "./adapter";

export function campaignDailyBudgets(campaigns: readonly RedditObject[]): Map<string, number | null> {
  return new Map(
    campaigns.map((c) => [c.id, c.goal_type === "DAILY_SPEND" && typeof c.goal_value === "number" && c.goal_value > 0 ? c.goal_value / 1000000 : null]),
  );
}

export async function readRedditAccounts(tenantId: string, start: Date, now = new Date()): Promise<AccountRead[]> {
  const connection = await resolveOwnedComposioAccount(tenantId, "reddit_ads");
  if (!connection) {
    const { asTenantId, tenantClient } = await import("@/services/tenant-client");
    const { data, error } = await tenantClient(asTenantId(tenantId)).from("connector_metadata").select("slug").eq("slug", "composio.reddit_ads").maybeSingle();
    if (error) throw new ConnectionUnknownError("Reddit Ads connection could not be checked.");
    if (data) {
      throw (await composioConnectionStoppedError(tenantId, "reddit_ads", "Reddit Ads"))
        ?? new Error("Reddit Ads connection cannot be verified; spend is unknown. Reconnect Reddit Ads.");
    }
    return [];
  }
  const accounts = await listAdAccounts(connection);
  const reads: AccountRead[] = [];
  for (const selected of accounts) {
    const { account, details } = await ownedAccount(tenantId, selected.id);
    if (details.currency !== "USD") throw new Error(`Reddit account ${selected.id} uses unsupported currency ${String(details.currency)}; shared spend cannot be reconciled as USD.`);
    if (typeof details.time_zone_id !== "string") throw new Error("Reddit account timezone is missing.");
    rememberAccountZone(tenantId, "reddit", selected.id, details.time_zone_id, now);
    const window = { since: dateInZone(start, details.time_zone_id), until: dateInZone(now, details.time_zone_id) };
    const campaigns = await listObjects(account, selected.id, "ad_group");
    const cbo = campaigns.some((g) => g.is_campaign_budget_optimization);
    const campaignBudget = cbo ? campaignDailyBudgets(await listObjects(account, selected.id, "campaign")) : new Map<string, number | null>();
    const rows = await reportRows(account, selected.id, window.since, window.until, details.time_zone_id, "ad_group");
    reads.push({ platform: "reddit", account_id: selected.id, window,
      campaigns: campaigns.map((g) =>
        g.is_campaign_budget_optimization
          ? { object_id: g.id, level: "ad_group", campaign_id: g.campaign_id ?? null, name: g.name ?? g.id, budget_kind: "campaign_level", budget_usd: null, campaign_budget_usd: g.campaign_id ? (campaignBudget.get(g.campaign_id) ?? null) : null, status: g.effective_status ?? null, currency: "USD" }
          : { object_id: g.id, level: "ad_group", campaign_id: g.campaign_id ?? null, name: g.name ?? g.id, budget_kind: g.goal_type === "DAILY_SPEND" ? "daily" : g.goal_type === "LIFETIME_SPEND" ? "lifetime" : "none", budget_usd: g.goal_value == null ? null : g.goal_value / 1000000, status: g.effective_status ?? null, currency: "USD" }),
      spend: rows.map((r) => {
        const id = r.ad_group_id ?? r.AD_GROUP_ID;
        const day = r.date ?? r.DATE;
        if (typeof id !== "string" || typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day.slice(0, 10))) throw new Error("Reddit returned a spend row without an object or calendar date.");
        const spend_date = day.slice(0, 10);
        const spend = metric(r, "SPEND");
        if (spend === null) throw new Error(`Reddit returned no spend amount for ${id} on ${spend_date}; shared spend cannot be reconciled.`);
        return { object_id: id, spend_date, amount_usd: spend / 1000000, provisional: spend_date === window.until };
      }),
    });
  }
  return reads;
}
const LEDGER_FRESH_MS = 75 * 60000;
const LEDGER_ROW_CAP = 1000;

export async function redditCapacity(tenantId: string, now = new Date()): Promise<{ connected: boolean; capacity_usd: number | null }> {
  try {
    const connection = await resolveOwnedComposioAccount(tenantId, "reddit_ads");
    if (!connection) {
      const { asTenantId, tenantClient } = await import("@/services/tenant-client");
      const { data, error } = await tenantClient(asTenantId(tenantId)).from("connector_metadata").select("slug").eq("slug", "composio.reddit_ads").maybeSingle();
      if (error || data) return { connected: true, capacity_usd: null };
      return { connected: false, capacity_usd: 0 };
    }
    const accounts = await listAdAccounts(connection);
    const { asTenantId, tenantClient } = await import("@/services/tenant-client");
    let capacity = 0;
    for (const account of accounts) {
      const { data, error } = await tenantClient(asTenantId(tenantId)).from("ad_campaigns").select("status,campaign_id,budget_kind,budget_usd,campaign_budget_usd,as_of").eq("platform", "reddit").eq("account_id", account.id).limit(LEDGER_ROW_CAP);
      if (error) throw error;
      if ((data ?? []).length >= LEDGER_ROW_CAP) return { connected: true, capacity_usd: null };
      const rows = (data ?? []) as Array<{ status: string; campaign_id: string | null; budget_kind: string; budget_usd: number | null; campaign_budget_usd: number | null; as_of: string }>;
      if (!rows.length) {
        const owned = await ownedAccount(tenantId, account.id);
        if (owned.details.currency !== "USD") return { connected: true, capacity_usd: null };
        if (!(await listObjects(connection, account.id, "ad_group")).length) continue;
        return { connected: true, capacity_usd: null };
      }
      if (rows.some((r) => String(r.status ?? "").toUpperCase() !== "REMOVED" && Date.parse(r.as_of) < now.getTime() - LEDGER_FRESH_MS)) return { connected: true, capacity_usd: null };
      const counted = new Set<string>();
      for (const row of rows) if (row.status === "ACTIVE") {
        if (row.budget_kind === "campaign_level") {
          if (!row.campaign_id || row.campaign_budget_usd == null) return { connected: true, capacity_usd: null };
          if (counted.has(row.campaign_id)) continue;
          counted.add(row.campaign_id);
          capacity += Number(row.campaign_budget_usd);
          continue;
        }
        if (row.budget_kind !== "daily" || row.budget_usd === null) return { connected: true, capacity_usd: null };
        capacity += Number(row.budget_usd);
      }
    }
    return { connected: true, capacity_usd: Math.round(capacity * 100) / 100 };
  } catch (e) {
    await import("@/services/logging/logEvent")
      .then(({ logEvent }) => logEvent({ level: "warn", source: "reddit-ads/capacity", code: "reddit_capacity_unreadable", error: e, tenant_id: tenantId }))
      .catch(() => undefined);
    return { connected: true, capacity_usd: null };
  }
}
