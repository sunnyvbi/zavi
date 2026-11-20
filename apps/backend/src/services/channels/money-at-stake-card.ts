
export const MONEY_AT_STAKE_KEY = "money_at_stake";

export type GoogleCardMoneyAtStake = {
  daily_budget_usd: number;
  scope: "campaign";
  campaign_id: string;
  source: "google_ads.campaign_budget";
};

export type MetaCardMoneyAtStake = {
  daily_budget_usd: number;
  scope: "campaign" | "adset";
  object_id: string;
  source: "meta_ads.daily_budget";
};

export type CardMoneyAtStake = GoogleCardMoneyAtStake | MetaCardMoneyAtStake;

export function readStakeBlock(cardBody: unknown): CardMoneyAtStake | null {
  if (!cardBody || typeof cardBody !== "object" || Array.isArray(cardBody)) return null;
  const raw = (cardBody as Record<string, unknown>)[MONEY_AT_STAKE_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;

  const daily = typeof b.daily_budget_usd === "number" ? b.daily_budget_usd : NaN;
  if (!Number.isFinite(daily) || daily <= 0) return null;

  if (b.source === "google_ads.campaign_budget") {
    if (b.scope !== "campaign") return null;
    if (typeof b.campaign_id !== "string" || b.campaign_id.length === 0) return null;
    return {
      daily_budget_usd: daily,
      scope: "campaign",
      campaign_id: b.campaign_id,
      source: "google_ads.campaign_budget",
    };
  }

  if (b.source === "meta_ads.daily_budget") {
    if (b.scope !== "campaign" && b.scope !== "adset") return null;
    if (typeof b.object_id !== "string" || b.object_id.length === 0) return null;
    return {
      daily_budget_usd: daily,
      scope: b.scope,
      object_id: b.object_id,
      source: "meta_ads.daily_budget",
    };
  }

  return null;
}
