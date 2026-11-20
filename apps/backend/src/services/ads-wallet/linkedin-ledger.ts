import { asTenantId, tenantClient } from "@/services/tenant-client";
import type { AccountRead } from "@/services/decisions/ad-budget-reconcile";
import { linkedinAdsGet } from "@/services/connectors/linkedin-ads/http";
import { goneLinkedinCampaignIds, linkedinGonePeriodSpend, linkedinLifetimeSpend } from "./adapters/linkedin";
import { decimalCents } from "./money";
import { campaignIdleSince } from "@/services/connectors/core/budget-ledger";

export async function readManagedLinkedinLedger(
  tenantId: string,
  start: Date,
  now: Date,
): Promise<AccountRead[]> {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("ads_campaign_binding_details")
    .select("id")
    .eq("platform", "linkedin")
    .eq("funding_source", "wallet")
    .order("id")
    .range(0, 999);
  if (error || !Array.isArray(data) || data.length === 1000)
    throw new Error("Managed LinkedIn inventory is incomplete");
  const accounts = new Map<string, AccountRead>();
  const day = (d: Date) => ({
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  });
  const gone = await goneLinkedinCampaignIds(tenantId);
  const bound = data as Array<{ id: string }>;
  const goneIds = bound.filter((row) => gone.has(row.id)).map((row) => row.id);
  if (goneIds.length) {
    const recorded = await tenantClient(asTenantId(tenantId))
      .from("ad_spend_daily")
      .select("account_id,object_id,spend_date,amount_usd,provisional")
      .eq("platform", "linkedin")
      .eq("source", "api")
      .in("object_id", goneIds)
      .gte("spend_date", start.toISOString().slice(0, 10))
      .range(0, 999);
    if (recorded.error || !Array.isArray(recorded.data) || recorded.data.length === 1000)
      throw new Error("Managed LinkedIn recorded spend is unavailable");
    for (const r of recorded.data as Array<{ account_id: string | null; object_id: string; spend_date: string; amount_usd: number | string; provisional: boolean | null }>) {
      if (!r.account_id) continue;
      const entry = accounts.get(r.account_id) ?? {
        platform: "linkedin" as const,
        managed: true,
        account_id: r.account_id,
        window: { since: start.toISOString().slice(0, 10), until: now.toISOString().slice(0, 10) },
        campaigns: [],
        spend: [],
      };
      entry.spend.push({ object_id: r.object_id, spend_date: r.spend_date, amount_usd: Number(r.amount_usd), provisional: r.provisional === true });
      accounts.set(r.account_id, entry);
    }
    const since = start.toISOString().slice(0, 10);
    for (const id of goneIds) {
      const late = await linkedinGonePeriodSpend(tenantId, id, start, now);
      if (!late) continue;
      const entry = accounts.get(late.account_id) ?? {
        platform: "linkedin" as const,
        managed: true,
        account_id: late.account_id,
        window: { since, until: now.toISOString().slice(0, 10) },
        campaigns: [],
        spend: [],
      };
      const rows = entry.spend.filter((r) => r.object_id === id);
      const missing = late.cents / 100 - rows.reduce((sum, r) => sum + r.amount_usd, 0);
      if (missing <= 0.004) continue;
      const row = rows.find((r) => r.spend_date === since);
      if (row) row.amount_usd += missing;
      else entry.spend.push({ object_id: id, spend_date: since, amount_usd: missing, provisional: true });
      accounts.set(late.account_id, entry);
    }
  }
  for (const row of bound.filter((b) => !gone.has(b.id))) {
    const c = await linkedinLifetimeSpend(tenantId, row.id);
    const window = {
      since: start.toISOString().slice(0, 10),
      until: now.toISOString().slice(0, 10),
    };
    let cents = 0;
    if (c.cents > 0) {
      const report = await linkedinAdsGet<{
        elements?: Array<{
          pivotValues?: string[];
          costInLocalCurrency?: string;
        }>;
      }>(
        c.token,
        "adAnalytics",
        {
          q: "analytics",
          pivot: "CAMPAIGN",
          timeGranularity: "ALL",
          dateRange: { start: day(start), end: day(now) },
          accounts: [`urn:li:sponsoredAccount:${c.account.id}`],
          campaigns: [`urn:li:sponsoredCampaign:${c.campaign.id}`],
        },
        { fields: "pivotValues,costInLocalCurrency" },
        { fresh: true },
      );
      const windowStart = `${window.since}T00:00:00Z`;
      const idle =
        (c.campaign.runSchedule.end != null &&
          c.campaign.runSchedule.end <= Date.parse(windowStart)) ||
        campaignIdleSince(
          c.campaign.status,
          c.campaign.changeAuditStamps?.lastModified?.time != null
            ? new Date(c.campaign.changeAuditStamps.lastModified.time).toISOString()
            : null,
          windowStart,
          ["PAUSED", "ARCHIVED", "CANCELED"],
        );
      if (
        !Array.isArray(report.elements) ||
        (report.elements.length === 0 && !idle)
      )
        throw new Error("Managed LinkedIn period spend is unavailable");
      if (report.elements.length > 0) {
        if (
          report.elements.length !== 1 ||
          report.elements[0].pivotValues?.length !== 1 ||
          report.elements[0].pivotValues[0] !==
            `urn:li:sponsoredCampaign:${c.campaign.id}`
        )
          throw new Error("Managed LinkedIn period spend is unavailable");
        cents = decimalCents(report.elements[0].costInLocalCurrency);
      }
    }
    const entry = accounts.get(c.account.id) ?? {
      platform: "linkedin" as const,
      managed: true,
      account_id: c.account.id,
      window,
      campaigns: [],
      spend: [],
    };
    entry.campaigns.push({
      object_id: row.id,
      campaign_id: row.id,
      level: "campaign",
      name: c.campaign.name,
      budget_kind: c.campaign.totalBudget
        ? "lifetime"
        : c.campaign.dailyBudget
          ? "daily"
          : "none",
      budget_usd: c.campaign.totalBudget
        ? decimalCents(c.campaign.totalBudget.amount) / 100
        : c.campaign.dailyBudget
          ? decimalCents(c.campaign.dailyBudget.amount) / 100
          : null,
      status: c.campaign.status,
      currency: c.account.currency,
    });
    entry.spend.push({
      object_id: row.id,
      spend_date: window.since,
      amount_usd: cents / 100,
      provisional: true,
    });
    accounts.set(c.account.id, entry);
  }
  return [...accounts.values()];
}
