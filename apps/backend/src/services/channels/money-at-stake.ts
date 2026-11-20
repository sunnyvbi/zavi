
import { updateCampaignBudgetBodySchema } from "@/services/tools/google-ads/write/_decision-bodies";
import { campaignBudgetAtStake } from "@/services/tools/google-ads/write/_stake-budget";
import {
  updateAdSetBudgetBodySchema,
  updateCampaignBudgetBodySchema as metaUpdateCampaignBudgetBodySchema,
} from "@/services/tools/meta-ads/write/_decision-bodies";
import { metaBudgetAtStake } from "@/services/tools/meta-ads/write/_stake-budget";
import { readStakeBlock } from "./money-at-stake-card";

export const DAYS_PER_MONTH = 30.4;

export type MoneyAtStakeBasis =
  | "budget_delta"
  | "live_daily_budget";

export type MoneyAtStake = {
  monthly_usd: number;
  basis: MoneyAtStakeBasis;
};

export function moneyAtStakeUsd(
  execClass: string | null | undefined,
  execPayload: unknown,
  cardBody?: unknown,
): MoneyAtStake | null {
  if (typeof execClass !== "string" || execClass.length === 0) return null;
  if (!execPayload || typeof execPayload !== "object" || Array.isArray(execPayload)) return null;
  const payload = execPayload as Record<string, unknown>;

  switch (execClass) {
    case "google_ads.update_campaign_budget":
    case "google_ads.update_campaign_budget_review": {
      const r = updateCampaignBudgetBodySchema.safeParse(payload);
      if (!r.success) return null;
      const delta = Math.abs(r.data.daily_budget_usd - r.data.expected_current_daily_budget_usd);
      return positive(delta * DAYS_PER_MONTH, "budget_delta");
    }

    case "meta_ads.update_ad_set_budget":
    case "meta_ads.update_ad_set_budget_review": {
      const r = updateAdSetBudgetBodySchema.safeParse(payload);
      if (!r.success) return null;
      if (r.data.currency && r.data.currency !== "USD") return null;
      const delta = Math.abs(r.data.daily_budget_usd - r.data.expected_current_daily_budget_usd);
      return positive(delta * DAYS_PER_MONTH, "budget_delta");
    }

    case "meta_ads.update_campaign_budget":
    case "meta_ads.update_campaign_budget_review": {
      const r = metaUpdateCampaignBudgetBodySchema.safeParse(payload);
      if (!r.success) return null;
      if (r.data.currency && r.data.currency !== "USD") return null;
      const delta = Math.abs(r.data.daily_budget_usd - r.data.expected_current_daily_budget_usd);
      return positive(delta * DAYS_PER_MONTH, "budget_delta");
    }

    default: {
      const stake = readStakeBlock(cardBody);
      if (!stake) return null;

      const gads = campaignBudgetAtStake(execClass, payload);
      if (gads) {
        if (stake.source !== "google_ads.campaign_budget") return null;
        if (stake.campaign_id !== gads.campaign_id) return null;
        return positive(stake.daily_budget_usd * DAYS_PER_MONTH, "live_daily_budget");
      }

      const meta = metaBudgetAtStake(execClass, payload);
      if (meta) {
        if (stake.source !== "meta_ads.daily_budget") return null;
        if (stake.object_id !== meta.object_id || stake.scope !== meta.scope) return null;
        return positive(stake.daily_budget_usd * DAYS_PER_MONTH, "live_daily_budget");
      }

      return null;
    }
  }
}

function positive(monthly_usd: number, basis: MoneyAtStakeBasis): MoneyAtStake | null {
  if (!Number.isFinite(monthly_usd) || monthly_usd <= 0) return null;
  return { monthly_usd: Math.round(monthly_usd * 100) / 100, basis };
}

export function maxMoneyAtStake(amounts: ReadonlyArray<MoneyAtStake | null>): number | null {
  let max: number | null = null;
  for (const a of amounts) {
    if (a && (max === null || a.monthly_usd > max)) max = a.monthly_usd;
  }
  return max;
}
