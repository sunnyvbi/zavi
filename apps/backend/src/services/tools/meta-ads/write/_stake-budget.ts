
import { fbGet, getAdAccountCurrency } from "../_client";
import { detectCbo } from "./_helpers";
import type { MetaCardMoneyAtStake } from "@/services/channels/money-at-stake-card";

type GraphBudgets = {
  daily_budget?: string | null;
  lifetime_budget?: string | null;
};

export function metaBudgetAtStake(
  execClass: string,
  body: Record<string, unknown>,
): { object_id: string; scope: "campaign" | "adset" } | null {
  if (execClass === "meta_ads.delete_campaign") {
    const campaign_id = typeof body.campaign_id === "string" ? body.campaign_id.trim() : "";
    return campaign_id ? { object_id: campaign_id, scope: "campaign" } : null;
  }
  if (execClass !== "meta_ads.set_status" && execClass !== "meta_ads.set_status_review") {
    return null;
  }
  const object_id = typeof body.object_id === "string" ? body.object_id.trim() : "";
  if (!object_id) return null;
  const level = body.level;
  if (level !== "campaign" && level !== "adset") return null;
  return { object_id, scope: level };
}

export async function readLiveDailyBudgetUsd(
  tenantId: string,
  objectId: string,
  scope: "campaign" | "adset",
  deps: {
    get?: typeof fbGet;
    currency?: typeof getAdAccountCurrency;
  } = {},
): Promise<number | null> {
  const get = deps.get ?? fbGet;
  const readCurrency = deps.currency ?? getAdAccountCurrency;
  try {
    const currency = await readCurrency(tenantId);
    if (currency.toUpperCase() !== "USD") return null;

    if (scope === "campaign") {
      const campaign = (await get(tenantId, objectId, {
        fields: "daily_budget",
      })) as GraphBudgets;
      return usdFromMinorUnits(campaign.daily_budget);
    }

    const adSet = (await get(tenantId, objectId, {
      fields: "daily_budget,campaign{daily_budget,lifetime_budget}",
    })) as GraphBudgets & { campaign?: GraphBudgets | null };
    if (adSet.campaign && detectCbo(adSet.campaign)) return null;
    return usdFromMinorUnits(adSet.daily_budget);
  } catch {
    return null;
  }
}

function usdFromMinorUnits(minor: string | null | undefined): number | null {
  if (minor == null) return null;
  const cents = Number(minor);
  if (!Number.isFinite(cents) || cents <= 0) return null;
  return Math.round(cents) / 100;
}

export async function readMetaCardMoneyAtStake(
  tenantId: string,
  execClass: string,
  body: Record<string, unknown>,
  deps?: Parameters<typeof readLiveDailyBudgetUsd>[3],
): Promise<MetaCardMoneyAtStake | null> {
  const at = metaBudgetAtStake(execClass, body);
  if (!at) return null;
  const daily = await readLiveDailyBudgetUsd(tenantId, at.object_id, at.scope, deps);
  if (daily === null) return null;
  return {
    daily_budget_usd: daily,
    scope: at.scope,
    object_id: at.object_id,
    source: "meta_ads.daily_budget",
  };
}
