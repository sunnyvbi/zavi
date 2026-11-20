import type Stripe from "stripe";
import { SIX_MONTH_MONTHS, termForPriceId } from "@/services/billing/plans";
import { anchorFor, cashShare, commissionEntries, type CommissionLine } from "./commission";
import { invoiceSubscriptionId } from "@/services/billing/invoice-refs";
import * as store from "./store";

export const AFFILIATE_EVENTS: ReadonlySet<string> = new Set([
  "invoice.paid",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.funds_withdrawn",
  "charge.dispute.funds_reinstated",
  "charge.dispute.closed",
  "credit_note.created",
  "credit_note.voided",
]);

export type AffiliateEventDeps = {
  listLines: (invoiceId: string) => Promise<Stripe.InvoiceLineItem[]>;
  retrieveCharge: (chargeId: string) => Promise<Stripe.Charge>;
  retrieveInvoice: (invoiceId: string) => Promise<Stripe.Invoice>;
  retrievePaymentIntent: (paymentIntentId: string) => Promise<Stripe.PaymentIntent>;
  retrieveRefund: (refundId: string) => Promise<Stripe.Refund>;
  retrieveSubscription: (subscriptionId: string) => Promise<Stripe.Subscription>;
  tenantForCustomer: typeof store.tenantForCustomer;
  referralFor: typeof store.referralFor;
  ownCardFingerprints: (memberId: string, exceptTenantId: string) => Promise<Set<string>>;
  markSelfReferral: typeof store.markSelfReferral;
  accrue: typeof store.accrue;
  refund: typeof store.refund;
  creditNote: typeof store.creditNote;
  dispute: typeof store.dispute;
};

const idOf = (v: unknown): string | null => (typeof v === "string" ? v : (v as { id?: string } | null)?.id ?? null);

export function monthsForLine(line: Stripe.InvoiceLineItem): number | null {
  const term = termForPriceId(idOf((line as unknown as { price?: unknown }).price));
  if (!term) return null;
  return term === "6mo" ? SIX_MONTH_MONTHS : 1;
}

export function toCommissionLine(line: Stripe.InvoiceLineItem): CommissionLine | null {
  const months = monthsForLine(line);
  if (months === null) return null;
  const l = line as unknown as {
    id: string;
    amount: number;
    amount_excluding_tax?: number | null;
    discount_amounts?: Array<{ amount: number }> | null;
    proration?: boolean;
    period?: { start?: number };
  };
  const base =
    typeof l.amount_excluding_tax === "number"
      ? l.amount_excluding_tax
      : l.amount - (l.discount_amounts ?? []).reduce((s, d) => s + (d.amount ?? 0), 0);
  return {
    id: l.id,
    amountCents: base,
    proration: Boolean(l.proration),
    periodStart: new Date((l.period?.start ?? 0) * 1000),
    months,
  };
}

type ReferredTenant = { tenantId: string; memberId: string; anchor: string | null; signals: Record<string, unknown> | null };

async function referredTenantForCustomer(customer: unknown, d: AffiliateEventDeps): Promise<ReferredTenant | null> {
  const customerId = idOf(customer);
  if (!customerId) return null;
  const tenantId = await d.tenantForCustomer(customerId);
  if (!tenantId) return null;
  const ref = await d.referralFor(tenantId);
  return ref ? { tenantId, memberId: ref.member_id, anchor: ref.anchor_at, signals: ref.signals ?? null } : null;
}

type InvoicePayment = { status?: string; payment?: { charge?: unknown; payment_intent?: unknown } | null };
type InvoiceChargeRefs = {
  id: string; charge?: unknown; payment_intent?: unknown; paid_out_of_band?: boolean;
  payments?: { data?: InvoicePayment[] } | null;
};

async function invoiceChargeId(inv: InvoiceChargeRefs, d: AffiliateEventDeps): Promise<string | "out_of_band" | null> {
  const fromRefs = (x: InvoiceChargeRefs): { charge: string | null; paymentIntent: string | null } => {
    const paid = (x.payments?.data ?? []).filter((p) => p.payment && (p.status === undefined || p.status === "paid"));
    const charge = idOf(x.charge) ?? paid.map((p) => idOf(p.payment?.charge)).find((c) => c) ?? null;
    const paymentIntent = idOf(x.payment_intent) ?? paid.map((p) => idOf(p.payment?.payment_intent)).find((c) => c) ?? null;
    return { charge, paymentIntent };
  };
  let refs = fromRefs(inv);
  if (refs.charge) return refs.charge;
  if (!refs.paymentIntent) {
    const pinned = (await d.retrieveInvoice(inv.id)) as unknown as InvoiceChargeRefs;
    if (pinned.paid_out_of_band) return "out_of_band";
    refs = fromRefs(pinned);
    if (refs.charge) return refs.charge;
  }
  if (!refs.paymentIntent) return null;
  return idOf((await d.retrievePaymentIntent(refs.paymentIntent)).latest_charge);
}

async function onInvoicePaid(inv: Stripe.Invoice, livemode: boolean, d: AffiliateEventDeps): Promise<string> {
  const i = inv as unknown as InvoiceChargeRefs & {
    currency: string; amount_paid: number; total: number;
    tax?: number | null; total_excluding_tax?: number | null; total_taxes?: Array<{ amount?: number }> | null;
    customer?: unknown; status_transitions?: { paid_at?: number | null };
  };
  const subscriptionId = invoiceSubscriptionId(i);
  if (!subscriptionId) return "not_subscription";
  const ref = await referredTenantForCustomer(i.customer, d);
  if (!ref) return "not_referred";
  if (ref.signals?.self_referral) return "self_referral";
  if (i.paid_out_of_band || i.currency !== "usd" || i.amount_paid <= 0) return "not_commissionable";
  const chargeId = await invoiceChargeId(i, d);
  if (chargeId === "out_of_band") return "not_commissionable";
  if (!chargeId) return "no_charge";

  const lines = (await d.listLines(i.id)).map(toCommissionLine).filter((l): l is CommissionLine => l !== null);
  const linesCents = lines.filter((l) => l.amountCents > 0).reduce((s, l) => s + l.amountCents, 0);
  if (linesCents <= 0) return "no_lines";
  const charge = await d.retrieveCharge(chargeId);
  const taxCents =
    typeof i.tax === "number" ? i.tax
    : typeof i.total_excluding_tax === "number" ? Math.max(0, i.total - i.total_excluding_tax)
    : (i.total_taxes ?? []).reduce((sum, t) => sum + (t.amount ?? 0), 0);
  const amountPaidCents = Math.min(i.amount_paid, charge.amount);
  const share = cashShare({ amountPaidCents, totalCents: i.total, taxCents }, linesCents);
  const paidAt = new Date((i.status_transitions?.paid_at ?? Math.floor(Date.now() / 1000)) * 1000);
  const fingerprint =
    (charge as unknown as { payment_method_details?: { card?: { fingerprint?: string | null } } }).payment_method_details?.card?.fingerprint ?? null;
  if (fingerprint && (await d.ownCardFingerprints(ref.memberId, ref.tenantId)).has(fingerprint)) {
    await d.markSelfReferral(ref.tenantId, ref.signals);
    return "self_referral";
  }

  let anchor = ref.anchor;
  if (!anchor) {
    const sub = await d.retrieveSubscription(subscriptionId);
    const start = (sub as unknown as { start_date?: number }).start_date;
    anchor = start ? new Date(start * 1000).toISOString() : anchorFor(lines)?.toISOString() ?? null;
  }
  if (!anchor) return "no_lines";
  for (let attempt = 0; attempt < 2; attempt++) {
    const entries = commissionEntries({ invoiceId: i.id, lines, anchor: new Date(anchor), share, livemode, paidAt });
    const out = await d.accrue({ tenantId: ref.tenantId, chargeId, chargeAmountCents: charge.amount, livemode, cardFingerprint: fingerprint, anchor, entries });
    if (out.outcome !== "anchor_moved" || !out.anchor_at) return out.outcome;
    anchor = out.anchor_at;
  }
  throw new Error("affiliate accrue: anchor kept moving");
}

async function referredCharge(chargeId: string, d: AffiliateEventDeps): Promise<Stripe.Charge | null> {
  const charge = await d.retrieveCharge(chargeId);
  if (!idOf((charge as unknown as { invoice?: unknown }).invoice)) return null;
  return (await referredTenantForCustomer(charge.customer, d)) ? charge : null;
}

export async function handleAffiliateEvent(event: Stripe.Event, d: AffiliateEventDeps): Promise<string> {
  if (!AFFILIATE_EVENTS.has(event.type)) return "ignored";
  const obj = event.data.object as unknown as Record<string, unknown>;
  if (event.type === "invoice.paid") return onInvoicePaid(obj as unknown as Stripe.Invoice, event.livemode, d);
  if (event.type === "charge.refunded") {
    const c = obj as unknown as Stripe.Charge;
    if (!(await referredCharge(c.id, d))) return "not_referred";
    return d.refund(c.id, c.amount_refunded ?? 0);
  }
  if (event.type.startsWith("charge.dispute.")) {
    const dispute = obj as unknown as Stripe.Dispute;
    const chargeId = idOf(dispute.charge);
    if (!chargeId || !(await referredCharge(chargeId, d))) return "not_referred";
    return d.dispute(dispute.id, chargeId, dispute.amount ?? 0, String(dispute.status));
  }
  if (event.type === "credit_note.created" || event.type === "credit_note.voided") {
    const cn = obj as unknown as { id: string; invoice?: unknown; total: number; refund?: unknown; status?: string };
    const invoiceId = idOf(cn.invoice);
    if (!invoiceId) return "no_invoice";
    const inv = await d.retrieveInvoice(invoiceId);
    const chargeId = idOf((inv as unknown as { charge?: unknown }).charge);
    if (!chargeId || !(await referredCharge(chargeId, d))) return "not_referred";
    const refundId = idOf(cn.refund);
    const refunded = refundId ? (await d.retrieveRefund(refundId)).amount : 0;
    const credited = Math.max(0, cn.total - refunded);
    const voided = event.type === "credit_note.voided" || cn.status === "void";
    if (credited === 0 && !voided) return "refund_only";
    return d.creditNote(cn.id, chargeId, credited, voided);
  }
  return "ignored";
}

export function defaultAffiliateEventDeps(stripe: () => Stripe): AffiliateEventDeps {
  return {
    listLines: async (invoiceId) => {
      const out: Stripe.InvoiceLineItem[] = [];
      for await (const l of stripe().invoices.listLineItems(invoiceId, { limit: 100 })) out.push(l);
      return out;
    },
    retrieveCharge: (id) => stripe().charges.retrieve(id),
    retrieveInvoice: (id) => stripe().invoices.retrieve(id),
    retrievePaymentIntent: (id) => stripe().paymentIntents.retrieve(id),
    retrieveRefund: (id) => stripe().refunds.retrieve(id),
    retrieveSubscription: (id) => stripe().subscriptions.retrieve(id),
    tenantForCustomer: store.tenantForCustomer,
    referralFor: store.referralFor,
    ownCardFingerprints: async (memberId, exceptTenantId) => {
      const out = new Set<string>();
      for (const customer of await store.ownCustomersOf(memberId, exceptTenantId)) {
        try {
          for await (const pm of stripe().customers.listPaymentMethods(customer, { type: "card", limit: 100 })) {
            if (pm.card?.fingerprint) out.add(pm.card.fingerprint);
          }
        } catch (e) {
          if ((e as { code?: string }).code !== "resource_missing") throw e;
        }
      }
      return out;
    },
    markSelfReferral: store.markSelfReferral,
    accrue: store.accrue,
    refund: store.refund,
    creditNote: store.creditNote,
    dispute: store.dispute,
  };
}
