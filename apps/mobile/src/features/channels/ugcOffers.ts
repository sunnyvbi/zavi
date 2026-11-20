import { creatorFeeBreakdown, MAX_PRICE_CENTS, parseUsdToCents } from "@zavi/shared";

export const offerTitleOf = (count: number) => `${count} UGC video${count > 1 ? "s" : ""}`;

export type OfferDraft = { count: string; price: string; days: string; product: boolean };

export const EMPTY_DRAFT: OfferDraft = { count: "1", price: "", days: "", product: false };

export const digits = (s: string) => s.replace(/\D/g, "");
export const priceText = (s: string) => s.replace(/[^\d.]/g, "");

const usd = (cents: number) =>
  cents % 100 === 0
    ? `$${(cents / 100).toLocaleString("en-US")}`
    : `$${Math.floor(cents / 100).toLocaleString("en-US")}.${String(cents % 100).padStart(2, "0")}`;

export type OfferCheck = {
  ready: boolean;
  feeLine: (to: string) => string;
  body: null | {
    kind: "ugc_video";
    terms: { title: string; content_type: "UGC video"; count: number };
    price_cents: number;
    delivery_days: number;
    product_needed: boolean;
  };
};

export function checkOffer(d: OfferDraft): OfferCheck {
  const price = parseUsdToCents(d.price);
  const n = Number(d.count) || 0;
  const days = Number(d.days) || 0;
  const cents = price !== null && price > 0 && price <= MAX_PRICE_CENTS ? price : null;
  const fees = cents !== null ? creatorFeeBreakdown(cents) : null;
  const ready = fees !== null && n > 0 && n <= 20 && days >= 1 && days <= 90;
  return {
    ready,
    feeLine: (to) => (fees ? `If ${to} accepts, you are asked to pay ${usd(fees.business_total_cents)} with Zavi's 10% fee.` : ""),
    body: ready
      ? {
          kind: "ugc_video",
          terms: { title: offerTitleOf(n), content_type: "UGC video", count: n },
          price_cents: cents as number,
          delivery_days: days,
          product_needed: d.product,
        }
      : null,
  };
}

export type OfferStatus = "open" | "accepted" | "declined" | "expired" | "withdrawn";
export type OfferLike = {
  proposed_by: "tenant" | "creator";
  status: OfferStatus;
  expired: boolean;
  awaiting_payment?: boolean;
  closed_unpaid?: boolean;
  terms?: Record<string, unknown> | null;
  kind?: string;
  delivery_days: number;
};

export function offerWhat(o: Pick<OfferLike, "kind" | "terms">): string {
  const t = o.terms?.title;
  if (typeof t === "string" && t.trim()) return t.trim();
  return o.kind === "ugc_video" ? "Custom video" : "Custom offer";
}

export function offerDue(o: Pick<OfferLike, "delivery_days" | "terms">): string {
  const d = o.terms?.["due_date"];
  if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
    return new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  }
  return `${o.delivery_days} days after it starts`;
}

export type OfferChip = { label: string; tone: "amber" | "green" | "muted" };

export function offerChip(o: OfferLike, first: string): OfferChip {
  const mine = o.proposed_by === "tenant";
  const open = o.status === "open" && !o.expired;
  const accepted = o.status === "accepted";
  const closedUnpaid = accepted && o.closed_unpaid === true;
  const paid = accepted && !closedUnpaid && o.awaiting_payment === false;
  if (closedUnpaid) return { label: "Closed, not paid", tone: "muted" };
  if (paid) return { label: "Paid, job started", tone: "green" };
  if (accepted) return { label: mine ? `${first} accepted` : "You accepted", tone: "green" };
  if (open) return { label: mine ? `Waiting for ${first}` : "Waiting for you", tone: "amber" };
  if (o.status === "declined") return { label: mine ? `${first} declined` : "You declined", tone: "muted" };
  return { label: o.status === "withdrawn" ? "Withdrawn" : "Expired", tone: "muted" };
}

export function offerHint(o: OfferLike, first: string): string | null {
  const mine = o.proposed_by === "tenant";
  const accepted = o.status === "accepted";
  if (accepted && o.closed_unpaid === true) {
    return `${mine ? `${first} accepted, but` : "You accepted, but"} this offer was not paid before it expired, so it closed. Nothing was charged and no job started. Send a new offer to work together.`;
  }
  if (accepted && o.awaiting_payment) return `${mine ? `${first} accepted` : "You accepted"}. Pay to start. Charged now. The job starts as soon as the payment goes through. Zavi keeps the money until you approve the work.`;
  if (accepted && o.awaiting_payment === false) return "Paid. The job has started and is in Your creators.";
  if (o.status === "open" && !o.expired) {
    return mine
      ? `If ${first} accepts, you are asked to pay and the job starts.`
      : `Accept and pay charges your card now and the job starts. No 72 hour wait, because ${first} made the offer.`;
  }
  return null;
}

export const canWithdraw = (o: Pick<OfferLike, "proposed_by" | "status" | "expired">) => o.proposed_by === "tenant" && o.status === "open" && !o.expired;
