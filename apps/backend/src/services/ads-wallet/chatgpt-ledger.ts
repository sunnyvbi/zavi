import { asTenantId, tenantClient } from "@/services/tenant-client";
import { getCampaignBinding } from "./bindings";
import { withBoundCampaign } from "./campaign-context";
import { adsFx, adsUsd } from "./fx";
import { ownedCampaign } from "@/services/connectors/chatgpt-ads/workspace";
import { chatgptAdsGet } from "@/services/connectors/chatgpt-ads/http";
import {
  accountDay,
  readChatgptAccount,
  verifiedDailySpend,
} from "@/services/connectors/chatgpt-ads/growth-ledger";
import type { ChatgptAdsInsightRow } from "@/services/connectors/chatgpt-ads/client";
import type { AccountRead } from "@/services/decisions/ad-budget-reconcile";

export async function readChatgptAccountsForBudget(
  tenantId: string,
  start: Date,
  now = new Date(),
): Promise<AccountRead[]> {
  const legacy = await readChatgptAccount(tenantId, start, now);
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("ads_campaign_binding_details")
    .select("id")
    .eq("platform", "chatgpt")
    .eq("funding_source", "provider")
    .range(0, 999);
  if (error || !Array.isArray(data) || data.length === 1000)
    throw new Error("Customer ChatGPT inventory is incomplete");
  const accounts = new Map<string, AccountRead>();
  for (const row of data as Array<{ id: string }>) {
    const binding = await getCampaignBinding(tenantId, row.id);
    const c = await withBoundCampaign(binding, () =>
      ownedCampaign(tenantId, binding.provider_campaign_id),
    );
    const account = await chatgptAdsGet<{
      id: string;
      currency_code: string;
      timezone: string;
    }>(c.key, "/ad_account");
    if (
      account.id !== c.providerAccountId ||
      !account.currency_code ||
      !account.timezone
    )
      throw new Error("Customer ChatGPT currency or timezone is unavailable");
    const fx = await adsFx(account.currency_code);
    const window = {
      since: accountDay(start, account.timezone),
      until: accountDay(now, account.timezone),
    };
    const result = await chatgptAdsGet<{
      data?: ChatgptAdsInsightRow[];
      has_more?: boolean;
    }>(c.key, `/campaigns/${encodeURIComponent(c.campaign.id)}/insights`, {
      aggregation_level: "campaign",
      time_granularity: "daily",
      includes: ["zero_impression_items"],
      time_ranges: [
        JSON.stringify({
          type: "date_range",
          ...window,
          timezone: account.timezone,
        }),
      ],
      fields: ["campaign_id", "readable_time", "spend"],
      limit: 2000,
    });
    if (result.has_more || !Array.isArray(result.data))
      throw new Error("Customer ChatGPT reporting is incomplete");
    const entry = accounts.get(account.id) ?? {
      platform: "chatgpt" as const,
      account_id: account.id,
      window,
      campaigns: [],
      spend: [],
    };
    entry.spend.push(
      ...verifiedDailySpend(
        c.campaign.id,
        result.data,
        window.since,
        window.until,
        account.timezone,
      ).map((r) => ({
        ...r,
        object_id: binding.id,
        amount_usd: adsUsd(r.amount_usd, fx),
      })),
    );
    const daily = c.campaign.budget?.daily_spend_limit_micros;
    const total = c.campaign.budget?.lifetime_spend_limit_micros;
    entry.campaigns.push({
      object_id: binding.id,
      campaign_id: binding.id,
      level: "campaign",
      name: c.campaign.name,
      budget_kind:
        daily != null ? "daily" : total != null ? "lifetime" : "none",
      budget_usd:
        daily != null
          ? adsUsd(daily / 1e6, fx)
          : total != null
            ? adsUsd(total / 1e6, fx)
            : null,
      status: c.campaign.status?.toUpperCase() ?? null,
      currency: "USD",
    });
    accounts.set(account.id, entry);
  }
  return [...(legacy ? [legacy] : []), ...accounts.values()];
}
