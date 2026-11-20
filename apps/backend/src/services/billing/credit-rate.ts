
import { globalClient } from "@/services/tenant-client";
import { tierCreditsFromBlob, type PaidTier } from "./tiers";

export const DEFAULT_CREDITS_PER_USD = 400;

export const MIN_CREDITS_PER_USD = 1;
export const MAX_CREDITS_PER_USD = 1_000_000;

export const MAX_TIER_CREDITS = 2_000_000_000;

export type PricingConfig = {
  creditsPerUsd: number;
  tiers: Record<number, number>;
};

export const DEFAULT_PRICING: PricingConfig = {
  creditsPerUsd: DEFAULT_CREDITS_PER_USD,
  tiers: {},
};

function toInt(raw: unknown): number | null {
  const n = typeof raw === "string" ? Number(raw.trim()) : typeof raw === "number" ? raw : NaN;
  return Number.isFinite(n) ? Math.floor(n) : null;
}

export function creditsPerUsdFromBlob(
  blob: { credits_per_usd?: unknown } | null | undefined,
): number | null {
  const n = toInt(blob?.credits_per_usd);
  if (n === null || n < MIN_CREDITS_PER_USD || n > MAX_CREDITS_PER_USD) return null;
  return n;
}

export function creditTiersFromBlob(
  blob: { credit_tiers?: unknown } | null | undefined,
): Record<number, number> {
  const raw = blob?.credit_tiers;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<number, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const usd = toInt(k);
    const credits = toInt(v);
    if (usd === null || usd <= 0) continue;
    if (credits === null || credits < 0 || credits > MAX_TIER_CREDITS) continue;
    out[usd] = credits;
  }
  return out;
}

export function pricingFromBlob(
  blob: { credits_per_usd?: unknown; credit_tiers?: unknown } | null | undefined,
): PricingConfig {
  return {
    creditsPerUsd: creditsPerUsdFromBlob(blob) ?? DEFAULT_CREDITS_PER_USD,
    tiers: creditTiersFromBlob(blob),
  };
}

export function creditsPerUsdRejection(raw: unknown): string | null {
  const n = toInt(raw);
  if (n === null) return "credits_per_usd must be a finite number";
  if (n < MIN_CREDITS_PER_USD || n > MAX_CREDITS_PER_USD) {
    return `credits_per_usd must be between ${MIN_CREDITS_PER_USD} and ${MAX_CREDITS_PER_USD}`;
  }
  return null;
}

export function creditTiersRejection(raw: unknown): string | null {
  if (raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return "credit_tiers must be a JSON object keyed by dollar amount, e.g. {\"50\": 25000}";
  }
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const usd = toInt(k);
    if (usd === null || usd <= 0) return `credit_tiers key "${k}" must be a positive whole-dollar amount`;
    const credits = toInt(v);
    if (credits === null) return `credit_tiers["${k}"] must be a whole number of credits`;
    if (credits < 0) return `credit_tiers["${k}"] must not be negative`;
    if (credits > MAX_TIER_CREDITS) return `credit_tiers["${k}"] exceeds the maximum of ${MAX_TIER_CREDITS}`;
  }
  return null;
}

export function patchTouchesPricing(patch: Record<string, unknown>): boolean {
  return (
    Object.prototype.hasOwnProperty.call(patch, "credits_per_usd") ||
    Object.prototype.hasOwnProperty.call(patch, "credit_tiers")
  );
}

type ConfigBlob = { credits_per_usd?: unknown; credit_tiers?: unknown; tier_credits?: unknown };

async function readBlob(): Promise<ConfigBlob | null> {
  const { data, error } = await globalClient()
    .from("system_config")
    .select("blob")
    .eq("id", 1)
    .maybeSingle<{ blob: ConfigBlob | null }>();
  if (error) throw new Error(`system_config read failed: ${error.message}`);
  return data?.blob ?? null;
}

export async function getPricingConfig(): Promise<PricingConfig> {
  try {
    return pricingFromBlob(await readBlob());
  } catch {
    return DEFAULT_PRICING;
  }
}

export async function getPricingConfigStrict(): Promise<PricingConfig> {
  return pricingFromBlob(await readBlob());
}

export async function getTierCreditsStrict(): Promise<Record<PaidTier, number>> {
  return tierCreditsFromBlob(await readBlob());
}
