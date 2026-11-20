
import { gadsGetCampaignBudget, createGoogleAdsReadSession } from "../_client";
import type { GoogleCardMoneyAtStake } from "@/services/channels/money-at-stake-card";

export function campaignBudgetAtStake(
  execClass: string,
  body: Record<string, unknown>,
): { campaign_id: string } | null {
  const id = (v: unknown): string | null =>
    typeof v === "string" && /^[0-9]+$/.test(v) ? v : null;

  if (execClass === "google_ads.set_status" || execClass === "google_ads.set_status_review") {
    const level = typeof body.level === "string" ? body.level : "campaign";
    if (level !== "campaign") return null;
    const campaign_id = id(body.campaign_id);
    return campaign_id ? { campaign_id } : null;
  }

  if (execClass === "google_ads.remove_resource") {
    if (body.level !== "campaign") return null;
    const campaign_id = id(body.campaign_id);
    return campaign_id ? { campaign_id } : null;
  }

  return null;
}

export async function readExclusiveCampaignDailyBudgetUsd(
  tenantId: string,
  campaignId: string,
  deps: {
    getBudget?: typeof gadsGetCampaignBudget;
    search?: (query: string) => Promise<unknown[]>;
  } = {},
): Promise<number | null> {
  const getBudget = deps.getBudget ?? gadsGetCampaignBudget;
  try {
    const live = await getBudget(tenantId, campaignId);
    const daily = Number(live.amount_micros) / 1_000_000;
    if (!Number.isFinite(daily) || daily <= 0) return null;
    if (!live.budget_resource) return null;

    const search = deps.search ?? createGoogleAdsReadSession(tenantId);
    const rows = (await search(
      "SELECT campaign.id, campaign.campaign_budget FROM campaign WHERE campaign.status != 'REMOVED'",
    )) as Array<{ campaign?: { id?: string | number; campaignBudget?: string } }>;
    const sharers = new Set(
      rows
        .filter((r) => r.campaign?.campaignBudget === live.budget_resource)
        .map((r) => String(r.campaign?.id ?? ""))
        .filter(Boolean),
    );
    if (sharers.size !== 1 || !sharers.has(String(campaignId))) return null;

    return Math.round(daily * 100) / 100;
  } catch {
    return null;
  }
}

export async function readCardMoneyAtStake(
  tenantId: string,
  execClass: string,
  body: Record<string, unknown>,
  deps?: Parameters<typeof readExclusiveCampaignDailyBudgetUsd>[2],
): Promise<GoogleCardMoneyAtStake | null> {
  const scope = campaignBudgetAtStake(execClass, body);
  if (!scope) return null;
  const daily = await readExclusiveCampaignDailyBudgetUsd(tenantId, scope.campaign_id, deps);
  if (daily === null) return null;
  return {
    daily_budget_usd: daily,
    scope: "campaign",
    campaign_id: scope.campaign_id,
    source: "google_ads.campaign_budget",
  };
}
