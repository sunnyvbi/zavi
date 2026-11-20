import { asTenantId, tenantClient } from "@/services/tenant-client";
import type { AccountRead, LedgerSpend } from "@/services/decisions/ad-budget-reconcile";
import { getChatgptAdsApiKey } from "./key-provider";
import { chatgptAdsGet } from "./http";
import { listChatgptAdsCampaigns, type ChatgptAdsInsightRow } from "./client";
import { normalizeCampaignName, ownsCampaignName, resolveTenantCampaignPrefix } from "./tenant-scope";
import { confirmsRequestedPeriod } from "@/services/tools/chatgpt-ads/read_performance";

export function accountDay(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  return ["year", "month", "day"].map(k => parts.find(p => p.type === k)!.value).join("-");
}
const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

export function verifiedDailySpend(campaignId: string, rows: ChatgptAdsInsightRow[], since: string, until: string, timezone: string): LedgerSpend[] {
  const expected = new Set<string>();
  for (let day = since; day <= until; day = nextDay(day)) expected.add(day);
  const result: LedgerSpend[] = [];
  for (const row of rows) {
    if (row.campaign_id !== campaignId || !Number.isSafeInteger(row.start_time) || typeof row.spend !== "number" || !Number.isFinite(row.spend) || row.spend < 0) throw new Error("Unverified ChatGPT spend row");
    const day = accountDay(new Date(row.start_time! * 1000), timezone);
    if (!expected.delete(day) || !confirmsRequestedPeriod([row], { from: day, to: day, timezone, days: 1 })) throw new Error("Incomplete or duplicate ChatGPT reporting period");
    result.push({ object_id: campaignId, spend_date: day, amount_usd: row.spend, provisional: day === until });
  }
  if (expected.size) throw new Error("Missing ChatGPT daily spend; previous budget actual retained");
  return result;
}

export async function readChatgptAccount(tenantId: string, start: Date, now = new Date()): Promise<AccountRead | null> {
  const db = tenantClient(asTenantId(tenantId));
  const funded = await db.from("ads_campaign_funding").select("campaign_id").eq("tenant_id", tenantId).limit(1).maybeSingle();
  if (funded.error) throw new Error("ChatGPT participation could not be verified");
  if (!funded.data) return null;
  const prefix = await resolveTenantCampaignPrefix(tenantId);
  const key = await getChatgptAdsApiKey();
  const inventory = await listChatgptAdsCampaigns(key);
  if (inventory.pages_exhausted || inventory.unreadable_campaigns > 0) throw new Error("Incomplete ChatGPT campaign inventory");
  const mine = inventory.campaigns.filter(c => ownsCampaignName(c.name, prefix));
  if (inventory.campaigns.some(c => normalizeCampaignName(c.name).startsWith(prefix) && !ownsCampaignName(c.name, prefix))) throw new Error("Ambiguous ChatGPT campaign ownership");
  if (mine.length > 50 || new Set(mine.map(c => c.id)).size !== mine.length) throw new Error("Incomplete ChatGPT campaign inventory");
  const account = await chatgptAdsGet<{ currency_code?: string; timezone?: string }>(key, "/ad_account");
  if (account.currency_code !== "USD" || !account.timezone) throw new Error("ChatGPT account currency or timezone unavailable");
  const timezone = account.timezone;
  const since = accountDay(start, timezone), until = accountDay(now, timezone);
  const spend: LedgerSpend[] = [];
  for (const c of mine) {
    const body = await chatgptAdsGet<{ data?: ChatgptAdsInsightRow[]; has_more?: boolean }>(key, `/campaigns/${encodeURIComponent(c.id)}/insights`, {
      aggregation_level: "campaign", time_granularity: "daily", includes: ["zero_impression_items"],
      time_ranges: [JSON.stringify({ type: "date_range", since, until, timezone })],
      fields: ["campaign_id", "readable_time", "spend"], limit: 2000,
    });
    if (!Array.isArray(body.data) || body.has_more) throw new Error("Incomplete ChatGPT spend response");
    spend.push(...verifiedDailySpend(c.id, body.data, since, until, timezone));
  }
  return {
    platform: "chatgpt", account_id: `chatgpt:${tenantId}`, window: { since, until }, spend,
    campaigns: mine.map(c => ({
      object_id: c.id, campaign_id: c.id, level: "campaign", name: c.name,
      budget_kind: c.budget?.daily_spend_limit_micros != null ? "daily" : c.budget?.lifetime_spend_limit_micros != null ? "lifetime" : "none",
      budget_usd: c.budget?.daily_spend_limit_micros != null ? c.budget.daily_spend_limit_micros / 1e6 : c.budget?.lifetime_spend_limit_micros != null ? c.budget.lifetime_spend_limit_micros / 1e6 : null,
      status: typeof c.end_time === "number" && c.end_time * 1000 <= now.getTime() ? c.end_time * 1000 + 48 * 3600000 <= now.getTime() ? "ENDED" : "ENDED_SETTLING" : c.status?.toUpperCase() ?? null, currency: "USD",
    })),
  };
}
