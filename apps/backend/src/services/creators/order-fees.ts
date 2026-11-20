
import { ExpectedToolError } from "@/services/tools/types";
import {
  BUSINESS_FEE_BPS,
  CREATOR_FEE_BPS,
  MAX_PRICE_CENTS,
  type CreatorFeeBreakdown,
  creatorFeeBreakdown,
} from "@zavi/shared";

export { BUSINESS_FEE_BPS, CREATOR_FEE_BPS, MAX_PRICE_CENTS, type CreatorFeeBreakdown };

export const MIN_BUSINESS_TOTAL_CENTS = 50;

export function computeCreatorFees(price_cents: number): CreatorFeeBreakdown {
  if (!Number.isInteger(price_cents) || price_cents <= 0 || price_cents > MAX_PRICE_CENTS) {
    throw new ExpectedToolError(
      "invalid_price",
      `A creator price must be a whole number of cents between 1 and ${MAX_PRICE_CENTS}.`,
    );
  }
  return creatorFeeBreakdown(price_cents);
}

export function assertOrderFeesConsistent(order: {
  id: string;
  price_cents: number;
  business_fee_cents: number;
  creator_fee_cents: number;
}): CreatorFeeBreakdown {
  const fees = computeCreatorFees(order.price_cents);
  if (
    order.business_fee_cents !== fees.business_fee_cents ||
    order.creator_fee_cents !== fees.creator_fee_cents
  ) {
    throw new ExpectedToolError(
      "order_fees_inconsistent",
      `Order ${order.id} carries fees (business ${order.business_fee_cents}, creator ${order.creator_fee_cents}) that do not match the fee rule for its price (${fees.business_fee_cents} / ${fees.creator_fee_cents}). No money moves on a mismatched order.`,
    );
  }
  return fees;
}
