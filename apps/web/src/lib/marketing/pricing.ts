
import { PRICING_CONFIG, includesForTier, sixMonthDiscountPct } from "@zavi/shared";
import { apiUrl } from "@/lib/api";

export type TierSlug = "free" | "starter" | "growth" | "pro";
export type PaidTierSlug = Exclude<TierSlug, "free">;

export const TIER_ORDER: readonly TierSlug[] = ["free", "starter", "growth", "pro"];

export type PlanTier = {
  slug: TierSlug;
  name: string;
  usd: number;
  sixMonthUsd: number;
  sixMonthPerMonthUsd: number;
  monthlyCredits: number;
  dailyCredits: number;
  includes: string[];
};

export type TopupPack = { usd: number; credits: number };

export type BillingTerm = "monthly" | "6mo";

export type LivePricing = {
  tiers: PlanTier[];
  freeDailyCredits: number;
  topupPacks: TopupPack[];
  sixMonthAvailable: boolean;
  sixMonthMonths: number;
  sixMonthDiscountPct: number;
};

export function isTierSlug(v: unknown): v is TierSlug {
  return typeof v === "string" && (TIER_ORDER as readonly string[]).includes(v);
}

export function tierRank(t: TierSlug): number {
  return TIER_ORDER.indexOf(t);
}

export function nextTier(t: TierSlug): PaidTierSlug | null {
  const i = tierRank(t);
  return i >= 0 && i < TIER_ORDER.length - 1 ? (TIER_ORDER[i + 1] as PaidTierSlug) : null;
}

const TIER_NAME: Record<TierSlug, string> = {
  free: PRICING_CONFIG.tiers.free.name,
  starter: PRICING_CONFIG.tiers.starter.name,
  growth: PRICING_CONFIG.tiers.growth.name,
  pro: PRICING_CONFIG.tiers.pro.name,
};

export function tierDisplayName(t: unknown): string {
  return isTierSlug(t) ? TIER_NAME[t] : "Pro";
}

const DAILY = PRICING_CONFIG.daily_credits;
const MONTHS = PRICING_CONFIG.six_month_term_months;
const price = (t: TierSlug) => PRICING_CONFIG.tiers[t];
const MONTHLY: Record<PaidTierSlug, number> = {
  starter: price("starter").monthly_credits,
  growth: price("growth").monthly_credits,
  pro: price("pro").monthly_credits,
};
const sixMo = (usd: number) =>
  Object.values(PRICING_CONFIG.tiers).find((t) => t.monthly_usd === usd)?.six_month_usd ??
  Math.round(usd * MONTHS * (1 - sixMonthDiscountPct() / 100));
const sixMoPerMonth = (usd: number) => Math.round(sixMo(usd) / MONTHS);
const packCredits = (usd: number) =>
  Object.values(PRICING_CONFIG.tiers).find((t) => t.monthly_usd === usd)?.monthly_credits ?? 0;

export const PRICING_FALLBACK: LivePricing = {
  freeDailyCredits: DAILY,
  sixMonthAvailable: false,
  sixMonthMonths: MONTHS,
  sixMonthDiscountPct: sixMonthDiscountPct(),
  tiers: [
    {
      slug: "free",
      name: TIER_NAME.free,
      usd: price("free").monthly_usd,
      sixMonthUsd: price("free").six_month_usd,
      sixMonthPerMonthUsd: 0,
      monthlyCredits: price("free").monthly_credits,
      dailyCredits: DAILY,
      includes: includesForTier("free"),
    },
    {
      slug: "starter",
      name: TIER_NAME.starter,
      usd: price("starter").monthly_usd,
      sixMonthUsd: price("starter").six_month_usd,
      sixMonthPerMonthUsd: Math.round(price("starter").six_month_usd / MONTHS),
      monthlyCredits: MONTHLY.starter,
      dailyCredits: DAILY,
      includes: includesForTier("starter"),
    },
    {
      slug: "growth",
      name: TIER_NAME.growth,
      usd: price("growth").monthly_usd,
      sixMonthUsd: price("growth").six_month_usd,
      sixMonthPerMonthUsd: Math.round(price("growth").six_month_usd / MONTHS),
      monthlyCredits: MONTHLY.growth,
      dailyCredits: DAILY,
      includes: includesForTier("growth"),
    },
    {
      slug: "pro",
      name: TIER_NAME.pro,
      usd: price("pro").monthly_usd,
      sixMonthUsd: price("pro").six_month_usd,
      sixMonthPerMonthUsd: Math.round(price("pro").six_month_usd / MONTHS),
      monthlyCredits: MONTHLY.pro,
      dailyCredits: DAILY,
      includes: includesForTier("pro"),
    },
  ],
  topupPacks: PRICING_CONFIG.topup_usd_packs.map((usd) => ({ usd, credits: packCredits(usd) })),
};

function nonNegInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

export function parsePublicPricing(raw: unknown): LivePricing {
  const j = (raw && typeof raw === "object" ? raw : {}) as {
    tiers?: unknown;
    free_daily_credits?: unknown;
    topup_packs?: unknown;
    six_month_available?: unknown;
    six_month_months?: unknown;
    six_month_discount_pct?: unknown;
  };
  const tiers: PlanTier[] = Array.isArray(j.tiers)
    ? (j.tiers as Record<string, unknown>[]).flatMap((t) => {
        if (!t || !isTierSlug(t.slug)) return [];
        const usd = nonNegInt(t.usd);
        const monthly = nonNegInt(t.monthly_credits);
        const daily = nonNegInt(t.daily_credits);
        if (usd === null || monthly === null || daily === null) return [];
        const includes = Array.isArray(t.includes)
          ? t.includes.filter((x): x is string => typeof x === "string")
          : [];
        return [
          {
            slug: t.slug,
            name: typeof t.name === "string" && t.name ? t.name : TIER_NAME[t.slug],
            usd,
            sixMonthUsd: nonNegInt(t.six_month_usd) ?? sixMo(usd),
            sixMonthPerMonthUsd: nonNegInt(t.six_month_per_month_usd) ?? sixMoPerMonth(usd),
            monthlyCredits: monthly,
            dailyCredits: daily,
            includes,
          },
        ];
      })
    : [];
  const packs: TopupPack[] = Array.isArray(j.topup_packs)
    ? (j.topup_packs as Record<string, unknown>[]).flatMap((p) => {
        const usd = nonNegInt(p?.usd);
        const credits = nonNegInt(p?.credits);
        return usd && credits ? [{ usd, credits }] : [];
      })
    : [];
  const complete = TIER_ORDER.every((s) => tiers.some((t) => t.slug === s));
  const daily = nonNegInt(j.free_daily_credits);
  return {
    tiers: complete
      ? TIER_ORDER.map((s) => tiers.find((t) => t.slug === s) as PlanTier)
      : PRICING_FALLBACK.tiers,
    freeDailyCredits: daily && daily > 0 ? daily : PRICING_FALLBACK.freeDailyCredits,
    topupPacks: packs.length > 0 ? packs : PRICING_FALLBACK.topupPacks,
    sixMonthAvailable: j.six_month_available === true,
    sixMonthMonths: nonNegInt(j.six_month_months) || PRICING_FALLBACK.sixMonthMonths,
    sixMonthDiscountPct: nonNegInt(j.six_month_discount_pct) || PRICING_FALLBACK.sixMonthDiscountPct,
  };
}

export function liveTier(pricing: LivePricing, slug: TierSlug): PlanTier {
  return (
    pricing.tiers.find((t) => t.slug === slug) ??
    (PRICING_FALLBACK.tiers.find((t) => t.slug === slug) as PlanTier)
  );
}

export function termChargeUsd(tier: PlanTier, term: BillingTerm): number {
  return term === "6mo" ? tier.sixMonthUsd : tier.usd;
}

export async function getLivePricing(): Promise<LivePricing> {
  try {
    const res = await fetch(apiUrl("/api/public/pricing"), {
      next: { revalidate: 60 },
    });
    if (!res.ok) return PRICING_FALLBACK;
    return parsePublicPricing(await res.json());
  } catch {
    return PRICING_FALLBACK;
  }
}

export async function fetchLivePricingClient(): Promise<LivePricing> {
  try {
    const res = await fetch(apiUrl("/api/public/pricing"));
    if (!res.ok) return PRICING_FALLBACK;
    return parsePublicPricing(await res.json());
  } catch {
    return PRICING_FALLBACK;
  }
}
