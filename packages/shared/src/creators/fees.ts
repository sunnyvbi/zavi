
export const CREATOR_FEE_BPS = 1500;

export const BUSINESS_FEE_BPS = 1000;

export const CREATOR_CURRENCY = "usd";

export const MAX_PRICE_CENTS = 10_000_000;

function assertCents(priceCents: number, label: string): void {
  if (!Number.isInteger(priceCents) || priceCents < 0) {
    throw new Error(
      `${label}: price must be a non-negative integer number of cents, got ${String(priceCents)}`,
    );
  }
}

function feeHalfUp(priceCents: number, bps: number): number {
  return Math.floor((priceCents * bps + 5000) / 10000);
}

export function creatorFeeCents(priceCents: number): number {
  assertCents(priceCents, "creatorFeeCents");
  return feeHalfUp(priceCents, CREATOR_FEE_BPS);
}

export function creatorReceivesCents(priceCents: number): number {
  return priceCents - creatorFeeCents(priceCents);
}

export const creatorPayoutCents = creatorReceivesCents;

export function businessFeeCents(priceCents: number): number {
  assertCents(priceCents, "businessFeeCents");
  return feeHalfUp(priceCents, BUSINESS_FEE_BPS);
}

export function businessPaysCents(priceCents: number): number {
  return priceCents + businessFeeCents(priceCents);
}

export const businessTotalCents = businessPaysCents;

export type FeeBreakdown = {
  price_cents: number;
  business_fee_cents: number;
  business_total_cents: number;
  creator_fee_cents: number;
  creator_payout_cents: number;
};

export function feeBreakdown(priceCents: number): FeeBreakdown {
  return {
    price_cents: priceCents,
    business_fee_cents: businessFeeCents(priceCents),
    business_total_cents: businessPaysCents(priceCents),
    creator_fee_cents: creatorFeeCents(priceCents),
    creator_payout_cents: creatorReceivesCents(priceCents),
  };
}

export type CreatorFeeBreakdown = FeeBreakdown & {
  zavi_gross_cents: number;
  currency: "usd";
};

export function creatorFeeBreakdown(priceCents: number): CreatorFeeBreakdown {
  const base = feeBreakdown(priceCents);
  return {
    ...base,
    zavi_gross_cents: base.business_total_cents - base.creator_payout_cents,
    currency: CREATOR_CURRENCY as "usd",
  };
}

export function formatUsdCents(cents: number): string {
  assertCents(cents, "formatUsdCents");
  const whole = Math.trunc(cents / 100);
  const rem = cents % 100;
  return rem === 0 ? `$${whole.toLocaleString("en-US")}` : `$${whole.toLocaleString("en-US")}.${String(rem).padStart(2, "0")}`;
}

export function parseUsdToCents(raw: string): number | null {
  const cleaned = String(raw ?? "").replace(/[$,\s]/g, "");
  if (cleaned === "" || !/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  const [dollars, decimals = ""] = cleaned.split(".");
  const cents = Number(dollars) * 100 + Number(decimals.padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}
