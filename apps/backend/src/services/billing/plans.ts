
import type { Plan } from "@/services/agents/entitlement";
import type { PricingConfig } from "./credit-rate";
import { PRICING_CONFIG, sixMonthDiscountPct } from "@zavi/shared";
import { PAID_TIERS, TIER_PRICE_USD, TOPUP_USD_PACKS, type PaidTier } from "./tiers";

export type Interval = "month" | "year";

export type PaidPlan = Extract<Plan, "solo" | "team" | "full">;

const PRICE_ENV: Record<PaidPlan, Record<Interval, string>> = {
  solo: { month: "STRIPE_PRICE_SOLO_MONTHLY", year: "STRIPE_PRICE_SOLO_ANNUAL" },
  team: { month: "STRIPE_PRICE_TEAM_MONTHLY", year: "STRIPE_PRICE_TEAM_ANNUAL" },
  full: { month: "STRIPE_PRICE_FULL_MONTHLY", year: "STRIPE_PRICE_FULL_ANNUAL" },
};

export function priceIdFor(plan: PaidPlan, interval: Interval): string | null {
  return process.env[PRICE_ENV[plan][interval]] ?? null;
}

export function stripeCreditUnitAmountCents(): number {
  const raw = Number(process.env.STRIPE_CREDIT_UNIT_AMOUNT_CENTS);
  return Number.isInteger(raw) && raw > 0 ? raw : 250;
}

export function creditsUnitPriceId(): string | null {
  return process.env.STRIPE_PRICE_CREDITS_UNIT ?? null;
}

export const SELF_SERVE_USD_RUNGS: readonly number[] = [
  50, 75, 100, 200, 300, 400, 500, 750, 1_000, 1_500, 2_000, 3_000, 4_000,
  5_000, 7_500, 10_000, 12_500, 15_000, 20_000, 25_000, 30_000,
];

export const POPULAR_USD_RUNG_INDEX = 8;

export function isSelfServeUsd(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && SELF_SERVE_USD_RUNGS.includes(n);
}

export function creditsForUsd(usd: number, cfg: PricingConfig): number {
  const override = cfg.tiers[usd];
  if (typeof override === "number" && Number.isFinite(override)) return override;
  return Math.round(usd * cfg.creditsPerUsd);
}

export function creditsForUsdCents(cents: number, cfg: PricingConfig): number {
  const rung = selfServeUsdForCents(cents);
  if (rung !== null) return creditsForUsd(rung, cfg);
  return Math.round((cents / 100) * cfg.creditsPerUsd);
}

export function selfServeLadder(cfg: PricingConfig): { usd: number; credits: number }[] {
  return SELF_SERVE_USD_RUNGS.map((usd) => ({ usd, credits: creditsForUsd(usd, cfg) }));
}

export function usdRungForCredits(credits: unknown, cfg: PricingConfig): number | null {
  if (typeof credits !== "number" || !Number.isInteger(credits)) return null;
  const hit = selfServeLadder(cfg).find((r) => r.credits === credits);
  return hit ? hit.usd : null;
}

export function selfServeUsdForCents(cents: unknown): number | null {
  if (typeof cents !== "number" || !Number.isInteger(cents) || cents <= 0) return null;
  if (cents % 100 !== 0) return null;
  const usd = cents / 100;
  return isSelfServeUsd(usd) ? usd : null;
}

export function stripeQuantityForUsd(usd: number): number | null {
  const cents = Math.round(usd * 100);
  const unit = stripeCreditUnitAmountCents();
  if (cents <= 0 || cents % unit !== 0) return null;
  return cents / unit;
}

export function planForPriceId(priceId: string | null | undefined): Plan | null {
  if (!priceId) return null;
  for (const plan of Object.keys(PRICE_ENV) as PaidPlan[]) {
    for (const interval of ["month", "year"] as Interval[]) {
      if (process.env[PRICE_ENV[plan][interval]] === priceId) return plan;
    }
  }
  return null;
}

const TIER_PRICE_ENV: Record<PaidTier, string> = {
  starter: "STRIPE_PRICE_STARTER_MONTHLY",
  growth: "STRIPE_PRICE_GROWTH_MONTHLY",
  pro: "STRIPE_PRICE_PRO_MONTHLY",
};

const TIER_PRICE_6MO_ENV: Record<PaidTier, string> = {
  starter: "STRIPE_PRICE_STARTER_6MO",
  growth: "STRIPE_PRICE_GROWTH_6MO",
  pro: "STRIPE_PRICE_PRO_6MO",
};

export const BILLING_TERMS = ["monthly", "6mo"] as const;
export type BillingTerm = (typeof BILLING_TERMS)[number];

export function isBillingTerm(v: unknown): v is BillingTerm {
  return typeof v === "string" && (BILLING_TERMS as readonly string[]).includes(v);
}

export const SIX_MONTH_MONTHS = PRICING_CONFIG.six_month_term_months;
export const SIX_MONTH_DISCOUNT_PCT = sixMonthDiscountPct();

export function sixMonthUsd(tier: PaidTier): number {
  return PRICING_CONFIG.tiers[tier].six_month_usd;
}

export function sixMonthPerMonthUsd(tier: PaidTier): number {
  return Math.round(sixMonthUsd(tier) / SIX_MONTH_MONTHS);
}

export type StripePriceTerms = {
  active?: boolean | null;
  currency?: string | null;
  unit_amount?: number | null;
  recurring?: { interval?: string | null; interval_count?: number | null } | null;
};

export function sixMonthPriceMismatch(tier: PaidTier, price: StripePriceTerms): string | null {
  if (price.active === false) return "price is archived";
  if ((price.currency ?? "").toLowerCase() !== "usd") return `currency is ${price.currency ?? "unset"}, not usd`;
  const want = sixMonthUsd(tier) * 100;
  if (price.unit_amount !== want) return `unit_amount is ${price.unit_amount ?? "unset"}, not ${want}`;
  const r = price.recurring;
  if (r?.interval !== "month" || r.interval_count !== SIX_MONTH_MONTHS) {
    return `recurs every ${r?.interval_count ?? "?"} ${r?.interval ?? "?"}, not every ${SIX_MONTH_MONTHS} month`;
  }
  return null;
}

export function sixMonthConfigured(): boolean {
  return PAID_TIERS.every((t) => tierPriceId(t, "6mo") !== null);
}

export function tierPriceId(tier: PaidTier, term: BillingTerm = "monthly"): string | null {
  const key = term === "6mo" ? TIER_PRICE_6MO_ENV[tier] : TIER_PRICE_ENV[tier];
  const v = process.env[key];
  return v && v.trim() ? v.trim() : null;
}

export function tierForPriceId(priceId: string | null | undefined): PaidTier | null {
  if (!priceId) return null;
  for (const t of PAID_TIERS) {
    for (const term of BILLING_TERMS) {
      if (tierPriceId(t, term) === priceId) return t;
    }
  }
  return null;
}

export function termForPriceId(priceId: string | null | undefined): BillingTerm | null {
  if (!priceId) return null;
  for (const t of PAID_TIERS) {
    for (const term of BILLING_TERMS) {
      if (tierPriceId(t, term) === priceId) return term;
    }
  }
  return null;
}

export function packTierForUsd(usd: unknown): PaidTier | null {
  if (typeof usd !== "number" || !Number.isInteger(usd) || !TOPUP_USD_PACKS.includes(usd)) return null;
  return PAID_TIERS.find((t) => TIER_PRICE_USD[t] === usd) ?? null;
}

export function packTierForCents(cents: unknown): PaidTier | null {
  if (typeof cents !== "number" || !Number.isInteger(cents) || cents <= 0 || cents % 100 !== 0) return null;
  return packTierForUsd(cents / 100);
}

export function billingConfigured(): boolean {
  if (!process.env.STRIPE_PLATFORM_SECRET_KEY) return false;
  const tierIds = PAID_TIERS.map((t) => tierPriceId(t));
  const allTiers = tierIds.every((v) => v !== null);
  if (!allTiers && !creditsUnitPriceId()) return false;
  const ids: string[] = [];
  for (const v of tierIds) if (v) ids.push(v);
  for (const t of PAID_TIERS) {
    const v = tierPriceId(t, "6mo");
    if (v) ids.push(v);
  }
  const unit = creditsUnitPriceId();
  if (unit) ids.push(unit);
  for (const plan of Object.keys(PRICE_ENV) as PaidPlan[]) {
    for (const interval of ["month", "year"] as Interval[]) {
      const v = process.env[PRICE_ENV[plan][interval]];
      if (v) ids.push(v);
    }
  }
  if (new Set(ids).size !== ids.length) return false;
  return true;
}

export const PAID_PLANS: readonly PaidPlan[] = ["solo", "team", "full"];
