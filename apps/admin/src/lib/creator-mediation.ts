export type MediationOutcome = "pay_full" | "pay_part" | "refund";

export type MediationResult = {
  money_frozen?: boolean;
  needs_staff_review?: boolean;
  payout_waiting?: boolean;
  payout_sent?: boolean | null;
};

export function mediationResultMessage(
  outcome: MediationOutcome,
  r: MediationResult,
): { tone: "ok" | "warn"; text: string } {
  if (r.needs_staff_review) {
    return {
      tone: "warn",
      text: "The decision was saved, but the money did not move as expected. Check this order in Stripe and in the money ledger below, and settle it by hand before telling either side it is done.",
    };
  }
  if (r.money_frozen) {
    return {
      tone: "warn",
      text: "The decision ran, but the dispute is still open, so the creator's payout stays frozen. Check the money ledger below and settle it by hand.",
    };
  }
  if (outcome === "refund") {
    return { tone: "ok", text: "Refunded. The job is cancelled and the business card is being refunded in full." };
  }
  const paid =
    outcome === "pay_full"
      ? "Paid in full."
      : "Paid part. The business has been refunded its share.";
  if (r.payout_waiting) {
    return {
      tone: "warn",
      text: `${paid} The creator has not finished Stripe setup, so their payout waits until they do. Nothing has reached them yet.`,
    };
  }
  if (r.payout_sent === false) {
    return {
      tone: "warn",
      text: `${paid} The decision is saved, but the creator's payout was not sent yet. Check the money ledger below before telling them it is on its way.`,
    };
  }
  if (r.payout_sent !== true) {
    return {
      tone: "warn",
      text: `${paid} The decision is saved, but Zavi could not confirm the creator's payout was sent. Check the money ledger below before telling them it is on its way.`,
    };
  }
  return { tone: "ok", text: `${paid} The creator's payout has been released.` };
}

export type PayPartLimits = { max_creator_amount_cents: number; max_refund_amount_cents: number; max_total_cents?: number };

export function payPartCheck(
  creatorCents: number | null,
  refundCents: number | null,
  limits: PayPartLimits,
): { ready: boolean; total: string | null; over: boolean } {
  const cap = limits.max_total_cents ?? limits.max_refund_amount_cents;
  const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
  if (creatorCents == null || refundCents == null) return { ready: false, total: null, over: false };
  const sum = creatorCents + refundCents;
  const over = sum > cap;
  const ready =
    creatorCents > 0 &&
    refundCents > 0 &&
    creatorCents <= limits.max_creator_amount_cents &&
    refundCents <= limits.max_refund_amount_cents &&
    !over;
  const total = over
    ? `${usd(creatorCents)} + ${usd(refundCents)} = ${usd(sum)}, which is ${usd(sum - cap)} more than the ${usd(cap)} the business paid.`
    : `${usd(creatorCents)} + ${usd(refundCents)} = ${usd(sum)} of the ${usd(cap)} the business paid.`;
  return { ready, total, over };
}
