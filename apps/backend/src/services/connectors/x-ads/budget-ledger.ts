import { asTenantId, tenantClient } from "@/services/tenant-client";
import { ConnectionUnknownError } from "@/services/connectors/core/budget-ledger";
import type { AccountRead } from "@/services/decisions/ad-budget-reconcile";
import {
  getXCampaign,
  listXAdAccountsRaw,
  listXCampaignRows,
  listXFundingInstruments,
  statsWindows,
  updateXCampaign,
  xAdsGet,
  xAdsTenantToken,
} from "./client";
import { assertXWriteAccess } from "./resources";
import { campaignIdleSince } from "@/services/connectors/core/budget-ledger";

export async function readXAccountsForBudget(
  tenantId: string,
  start: Date,
  now = new Date(),
): Promise<AccountRead[]> {
  const db = tenantClient(asTenantId(tenantId));
  const connected = await db
    .from("connector_metadata")
    .select("slug")
    .eq("slug", "x_ads")
    .maybeSingle();
  if (connected.error)
    throw new ConnectionUnknownError("X Ads connection could not be checked.");
  if (!connected.data) return [];
  const token = await xAdsTenantToken(tenantId);
  const accounts = await listXAdAccountsRaw(token);
  const reads: AccountRead[] = [];
  for (const account of accounts) {
    const campaigns = await listXCampaignRows(token, account.id, {
      withDeleted: true,
      max: 10000,
    });
    const funding = await listXFundingInstruments(token, account.id);
    if (
      campaigns.some((c) => c.currency !== "USD") ||
      funding.some((f) => f.currency !== "USD")
    )
      throw new Error("Shared ad budgets require USD X Ads accounts.");
    const window = {
      since: start.toISOString().slice(0, 10),
      until: now.toISOString().slice(0, 10),
    };
    const daily = new Map<string, number>();
    const running = campaigns.some((c) => !campaignIdleSince(c.status, c.updated_at, `${window.since}T00:00:00Z`, ["PAUSED", "DELETED"]));
    let skippedSilent = false;
    let billed = false;
    if (campaigns.length)
      for (const w of statsWindows(window.since, window.until))
        for (const placement of ["ALL_ON_TWITTER", "SPOTLIGHT", "TREND"]) {
          const end = new Date(
            Math.min(
              Date.parse(w.end),
              Math.floor(now.getTime() / 3600000) * 3600000,
            ),
          ).toISOString();
          if (Date.parse(end) <= Date.parse(w.start)) continue;
          const result = await xAdsGet<{
            data?: Array<{
              id: string;
              id_data?: Array<{
                metrics?: { billed_charge_local_micro?: Array<number | null> };
              }>;
            }>;
          }>(token, `stats/accounts/${account.id}`, {
            entity: "ACCOUNT",
            entity_ids: account.id,
            metric_groups: "BILLING",
            granularity: "HOUR",
            placement,
            start_time: w.start,
            end_time: end,
          });
          const row = result.data?.find((r) => r.id === account.id);
          const silent = !row?.id_data?.length || row.id_data.every((s) => { const a = s.metrics?.billed_charge_local_micro; return a == null || (Array.isArray(a) && a.every((v) => v == null)); });
          if (silent && !running) {
            skippedSilent = true;
            continue;
          }
          billed = true;
          if (!row?.id_data?.length)
            throw new Error(
              "X Ads account billing data is missing; spend is unknown.",
            );
          const hours = (Date.parse(end) - Date.parse(w.start)) / 3600000;
          for (const segment of row.id_data) {
            const amounts = segment.metrics?.billed_charge_local_micro;
            if (
              !amounts ||
              amounts.length !== hours ||
              amounts.some(
                (v) => typeof v !== "number" || !Number.isFinite(v) || v < 0,
              )
            )
              throw new Error(
                "X Ads returned incomplete hourly billing; spend is unknown.",
              );
            amounts.forEach((amount, i) => {
              const date = new Date(Date.parse(w.start) + i * 3600000)
                .toISOString()
                .slice(0, 10);
              daily.set(date, (daily.get(date) ?? 0) + amount! / 1000000);
            });
          }
        }
    if (skippedSilent && billed) throw new Error("X Ads returned incomplete hourly billing; spend is unknown.");
    reads.push({
      platform: "x",
      account_id: account.id,
      window,
      campaigns: campaigns.map((c) => ({
        object_id: c.campaign_id,
        campaign_id: c.campaign_id,
        level: "campaign",
        name: c.name,
        budget_kind:
          c.daily_budget != null
            ? "daily"
            : c.total_budget != null
              ? "lifetime"
              : "none",
        budget_usd: c.daily_budget ?? c.total_budget,
        status: c.status,
        currency: c.currency ?? "UNKNOWN",
      })),
      spend: [...daily].map(([spend_date, amount_usd]) => ({
        object_id: `account_${account.id}`,
        spend_date,
        amount_usd,
        provisional: spend_date === window.until,
      })),
    });
  }
  return reads;
}
export async function pauseXBudgetObject(tenantId: string, objectId: string) {
  const db = tenantClient(asTenantId(tenantId));
  const { data, error } = await db
    .from("ad_campaigns")
    .select("account_id")
    .eq("platform", "x")
    .eq("object_id", objectId)
    .maybeSingle<{ account_id: string }>();
  if (error || !data)
    throw new Error(
      "Cannot resolve the X Ads campaign account; its budget hold remains.",
    );
  const token = await xAdsTenantToken(tenantId);
  await assertXWriteAccess(token, data.account_id);
  const campaign = await getXCampaign(token, data.account_id, objectId);
  if (!campaign || campaign.status === "PAUSED") return;
  await updateXCampaign(token, data.account_id, objectId, {
    entity_status: "PAUSED",
  });
  if (
    (await getXCampaign(token, data.account_id, objectId))?.status !== "PAUSED"
  )
    throw new Error(
      "X Ads pause could not be confirmed; its budget hold remains.",
    );
}
export async function xSpendCapacity(
  tenantId: string,
  now = new Date(),
): Promise<{ connected: boolean; capacity_usd: number | null }> {
  try {
    const reads = await readXAccountsForBudget(tenantId, now, now);
    let capacity = 0;
    for (const account of reads)
      for (const campaign of account.campaigns)
        if (campaign.status === "ACTIVE") {
          if (campaign.budget_kind !== "daily" || campaign.budget_usd == null)
            return { connected: true, capacity_usd: null };
          capacity += campaign.budget_usd * 2;
        }
    return { connected: reads.length > 0, capacity_usd: capacity };
  } catch {
    return { connected: true, capacity_usd: null };
  }
}
