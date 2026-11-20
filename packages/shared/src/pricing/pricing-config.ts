
import raw from "./pricing.config.json";

export const PRICING_TIERS = ["free", "starter", "growth", "pro"] as const;
export type PricingTier = (typeof PRICING_TIERS)[number];
export type PricingPaidTier = Exclude<PricingTier, "free">;
export const PRICING_PAID_TIERS: readonly PricingPaidTier[] = ["starter", "growth", "pro"];

export type TierPricing = {
  name: string;
  monthly_usd: number;
  six_month_usd: number;
  monthly_credits: number;
};

export type PricingChannel = { name: string; slug?: string };

export type PricingFeature = {
  key: string;
  label: string;
  min_tier: PricingTier;
  agents?: string[];
  channels?: PricingChannel[];
};

export type PricingConfig = {
  currency: "usd";
  six_month_term_months: number;
  daily_credits: number;
  tiers: Record<PricingTier, TierPricing>;
  topup_usd_packs: number[];
  features: PricingFeature[];
};

const isWhole = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

export function parsePricingConfig(input: unknown): PricingConfig {
  const c = (input ?? {}) as Record<string, unknown>;
  const errs: string[] = [];
  if (c.currency !== "usd") errs.push(`currency must be "usd"`);
  if (!isWhole(c.six_month_term_months) || c.six_month_term_months < 1) errs.push("six_month_term_months must be a whole number >= 1");
  if (!isWhole(c.daily_credits) || c.daily_credits < 1) errs.push("daily_credits must be a whole number >= 1");

  const tiers = (c.tiers ?? {}) as Record<string, Record<string, unknown>>;
  for (const t of PRICING_TIERS) {
    const tier = tiers[t];
    if (!tier || typeof tier !== "object") {
      errs.push(`tiers.${t} is missing`);
      continue;
    }
    if (typeof tier.name !== "string" || !tier.name.trim()) errs.push(`tiers.${t}.name must be a non-empty string`);
    for (const k of ["monthly_usd", "six_month_usd", "monthly_credits"] as const) {
      if (!isWhole(tier[k])) errs.push(`tiers.${t}.${k} must be a whole number >= 0`);
    }
    if (t === "free") {
      if (tier.monthly_usd !== 0 || tier.six_month_usd !== 0) errs.push("tiers.free must cost 0");
    } else if (isWhole(tier.monthly_usd) && isWhole(tier.six_month_usd) && isWhole(c.six_month_term_months)) {
      if (tier.monthly_usd < 1) errs.push(`tiers.${t}.monthly_usd must be >= 1`);
      if (tier.six_month_usd < 1) errs.push(`tiers.${t}.six_month_usd must be >= 1`);
      if (tier.six_month_usd > tier.monthly_usd * c.six_month_term_months) {
        errs.push(`tiers.${t}.six_month_usd must not exceed ${c.six_month_term_months} × monthly_usd`);
      }
    }
  }
  for (const a of PRICING_PAID_TIERS) {
    for (const b of PRICING_PAID_TIERS) {
      if (a < b && tiers[a]?.monthly_usd === tiers[b]?.monthly_usd) errs.push(`tiers.${a} and tiers.${b} share a monthly_usd`);
    }
  }

  const packs = c.topup_usd_packs;
  if (!Array.isArray(packs) || packs.length === 0) {
    errs.push("topup_usd_packs must be a non-empty array");
  } else {
    for (const p of packs) {
      if (!isWhole(p) || !PRICING_PAID_TIERS.some((t) => tiers[t]?.monthly_usd === p)) {
        errs.push(`topup_usd_packs entry ${JSON.stringify(p)} must equal a paid tier's monthly_usd`);
      }
    }
  }

  const features = c.features;
  if (!Array.isArray(features) || features.length === 0) {
    errs.push("features must be a non-empty array");
  } else {
    const keys = new Set<string>();
    for (const [i, f] of (features as Record<string, unknown>[]).entries()) {
      const at = `features[${i}]`;
      if (!f || typeof f !== "object") {
        errs.push(`${at} must be an object`);
        continue;
      }
      if (typeof f.key !== "string" || !f.key) errs.push(`${at}.key must be a non-empty string`);
      else if (keys.has(f.key)) errs.push(`${at}.key "${f.key}" is duplicated`);
      else keys.add(f.key);
      if (typeof f.label !== "string" || !f.label.trim()) errs.push(`${at}.label must be a non-empty string`);
      if (!(PRICING_TIERS as readonly unknown[]).includes(f.min_tier)) errs.push(`${at}.min_tier must be one of ${PRICING_TIERS.join(", ")}`);
      if (f.channels !== undefined) {
        const ok =
          Array.isArray(f.channels) &&
          f.channels.length > 0 &&
          f.channels.every(
            (ch: unknown) =>
              !!ch &&
              typeof (ch as PricingChannel).name === "string" &&
              !!(ch as PricingChannel).name.trim() &&
              ((ch as PricingChannel).slug === undefined || typeof (ch as PricingChannel).slug === "string"),
          );
        if (!ok) errs.push(`${at}.channels must be a non-empty array of { name, slug? }`);
      }
    }
  }

  if (errs.length) throw new Error(`pricing.config.json is invalid:\n- ${errs.join("\n- ")}`);
  return c as unknown as PricingConfig;
}

export const PRICING_CONFIG: Readonly<PricingConfig> = parsePricingConfig(raw);

export function sixMonthDiscountPctFor(tier: PricingPaidTier, cfg: PricingConfig = PRICING_CONFIG): number {
  const full = cfg.tiers[tier].monthly_usd * cfg.six_month_term_months;
  return Math.round((1 - cfg.tiers[tier].six_month_usd / full) * 100);
}

export function sixMonthDiscountPct(cfg: PricingConfig = PRICING_CONFIG): number {
  return Math.min(...PRICING_PAID_TIERS.map((t) => sixMonthDiscountPctFor(t, cfg)));
}

export function tierHasPricingFeature(tier: PricingTier, f: PricingFeature): boolean {
  return PRICING_TIERS.indexOf(tier) >= PRICING_TIERS.indexOf(f.min_tier);
}

export function includesForTier(tier: PricingTier, cfg: PricingConfig = PRICING_CONFIG): string[] {
  const lines = cfg.features
    .filter((f) => f.min_tier === tier)
    .flatMap((f) => (f.channels ? f.channels.map((c) => c.name) : [f.label]));
  const i = PRICING_TIERS.indexOf(tier);
  if (i === 0) return lines;
  const lower = cfg.tiers[PRICING_TIERS[i - 1]].name;
  return [`Everything in ${lower}, plus:`, ...(lines.length ? lines : ["More monthly credits"])];
}
