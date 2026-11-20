
import type { Request, Response } from "express";
import { pricingFromBlob } from "@/services/billing/credit-rate";
import {
  selfServeLadder,
  POPULAR_USD_RUNG_INDEX,
  sixMonthUsd,
  sixMonthPerMonthUsd,
  sixMonthConfigured,
  SIX_MONTH_MONTHS,
  SIX_MONTH_DISCOUNT_PCT,
} from "@/services/billing/plans";
import { globalClient } from "@/services/tenant-client";
import { PRICING_CONFIG, includesForTier } from "@zavi/shared";
import { freeDailyCreditsFromBlob } from "@/services/agents/credits";
import {
  PAID_TIERS,
  TIERS,
  TIER_DISPLAY_NAME,
  TIER_PRICE_USD,
  TOPUP_USD_PACKS,
  tierCreditsFromBlob,
  type PaidTier,
  type Tier,
} from "@/services/billing/tiers";

export const PUBLIC_FREE_DAILY_FALLBACK = PRICING_CONFIG.daily_credits;

export type PublicTier = {
  slug: Tier;
  name: string;
  usd: number;
  six_month_usd: number;
  six_month_per_month_usd: number;
  monthly_credits: number;
  daily_credits: number;
  includes: string[];
};

export function buildPublicPricing(blob: Record<string, unknown> | null | undefined) {
  const daily = freeDailyCreditsFromBlob(blob) ?? PUBLIC_FREE_DAILY_FALLBACK;
  const monthly = tierCreditsFromBlob(blob);
  const includes = Object.fromEntries(TIERS.map((t) => [t, includesForTier(t)])) as Record<Tier, string[]>;

  const tiers: PublicTier[] = [
    {
      slug: "free",
      name: TIER_DISPLAY_NAME.free,
      usd: PRICING_CONFIG.tiers.free.monthly_usd,
      six_month_usd: PRICING_CONFIG.tiers.free.six_month_usd,
      six_month_per_month_usd: 0,
      monthly_credits: PRICING_CONFIG.tiers.free.monthly_credits,
      daily_credits: daily,
      includes: includes.free,
    },
    ...PAID_TIERS.map((t) => ({
      slug: t,
      name: TIER_DISPLAY_NAME[t],
      usd: TIER_PRICE_USD[t],
      six_month_usd: sixMonthUsd(t),
      six_month_per_month_usd: sixMonthPerMonthUsd(t),
      monthly_credits: monthly[t],
      daily_credits: daily,
      includes: includes[t],
    })),
  ];

  const topup_packs = TOPUP_USD_PACKS.map((usd) => {
    const tier = PAID_TIERS.find((t) => TIER_PRICE_USD[t] === usd);
    return { usd, credits: tier ? monthly[tier] : 0 };
  }).filter((p) => p.credits > 0);

  const legacy = pricingFromBlob(blob as Parameters<typeof pricingFromBlob>[0]);
  return {
    tiers,
    free_daily_credits: daily,
    six_month_available: sixMonthConfigured(),
    six_month_months: SIX_MONTH_MONTHS,
    six_month_discount_pct: SIX_MONTH_DISCOUNT_PCT,
    topup_packs,
    credits_per_usd: legacy.creditsPerUsd,
    popular_index: POPULAR_USD_RUNG_INDEX,
    rungs: selfServeLadder(legacy),
  };
}

export async function publicPricing(_req: Request, res: Response): Promise<void> {
  let blob: Record<string, unknown> | null = null;
  try {
    const { data } = await globalClient()
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle<{ blob: Record<string, unknown> | null }>();
    blob = data?.blob ?? null;
  } catch {
    blob = null;
  }

  res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  res.json(buildPublicPricing(blob));
}
