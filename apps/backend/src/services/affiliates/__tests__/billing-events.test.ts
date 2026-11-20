import { describe, it, expect, vi, beforeEach } from "vitest";
import type Stripe from "stripe";

beforeEach(() => {
  process.env.STRIPE_PRICE_STARTER_MONTHLY = "price_starter_m";
  process.env.STRIPE_PRICE_STARTER_6MO = "price_starter_6";
});
import { handleAffiliateEvent, type AffiliateEventDeps } from "../billing-events";

const ts = (s: string) => Math.floor(new Date(`${s}T00:00:00Z`).getTime() / 1000);
const line = (over: Record<string, unknown> = {}) =>
  ({ id: "il_1", amount: 2000, amount_excluding_tax: 2000, discount_amounts: [], proration: false, price: { id: "price_starter_m" }, period: { start: ts("2026-01-31") }, ...over }) as unknown as Stripe.InvoiceLineItem;

function deps(over: Partial<AffiliateEventDeps> = {}) {
  const d: AffiliateEventDeps = {
    listLines: vi.fn(async () => [line()]),
    retrieveCharge: vi.fn(async (id: string) => ({ id, amount: 2000, customer: "cus_1", invoice: "in_1" }) as unknown as Stripe.Charge),
    retrieveInvoice: vi.fn(async () => ({ id: "in_1", charge: "ch_1" }) as unknown as Stripe.Invoice),
    retrievePaymentIntent: vi.fn(async (id: string) => ({ id, latest_charge: "ch_pi" }) as unknown as Stripe.PaymentIntent),
    retrieveRefund: vi.fn(async () => ({ amount: 500 }) as unknown as Stripe.Refund),
    retrieveSubscription: vi.fn(async () => ({ start_date: ts("2026-01-31") }) as unknown as Stripe.Subscription),
    tenantForCustomer: vi.fn(async () => "t1"),
    referralFor: vi.fn(async () => ({ member_id: "m1", anchor_at: null })),
    ownCardFingerprints: vi.fn(async () => new Set<string>()),
    markSelfReferral: vi.fn(async () => undefined),
    accrue: vi.fn(async () => ({ outcome: "accrued" })),
    refund: vi.fn(async () => "recorded"),
    creditNote: vi.fn(async () => "recorded"),
    dispute: vi.fn(async () => "recorded"),
    ...over,
  };
  return d;
}
const ev = (type: string, object: Record<string, unknown>, livemode = true) => ({ type, livemode, data: { object } }) as unknown as Stripe.Event;
const invoice = (over: Record<string, unknown> = {}) => ({
  id: "in_1", charge: "ch_1", subscription: "sub_1", currency: "usd", amount_paid: 2000, total: 2000, tax: 0,
  customer: "cus_1", status_transitions: { paid_at: ts("2026-02-01") }, ...over,
});

describe("self-referral by payment card", () => {
  const paidWith = (fingerprint: string | null) =>
    vi.fn(async (id: string) => ({ id, amount: 2000, customer: "cus_1", invoice: "in_1", payment_method_details: { card: { fingerprint } } }) as unknown as Stripe.Charge);

  it("a referred workspace paying with a card saved on the creator's own workspace earns nothing and is marked", async () => {
    const d = deps({ retrieveCharge: paidWith("fp_creator"), ownCardFingerprints: vi.fn(async () => new Set(["fp_creator"])) });
    expect(await handleAffiliateEvent(ev("invoice.paid", invoice()), d)).toBe("self_referral");
    expect(d.ownCardFingerprints).toHaveBeenCalledWith("m1", "t1");
    expect(d.markSelfReferral).toHaveBeenCalledWith("t1", null);
    expect(d.accrue).not.toHaveBeenCalled();
  });

  it("a different card accrues as usual", async () => {
    const d = deps({ retrieveCharge: paidWith("fp_customer"), ownCardFingerprints: vi.fn(async () => new Set(["fp_creator"])) });
    expect(await handleAffiliateEvent(ev("invoice.paid", invoice()), d)).toBe("accrued");
    expect(d.markSelfReferral).not.toHaveBeenCalled();
  });

  it("a referral already marked earns nothing on later invoices, whatever card pays", async () => {
    const d = deps({
      retrieveCharge: paidWith("fp_customer"),
      referralFor: vi.fn(async () => ({ member_id: "m1", anchor_at: null, signals: { self_referral: "own_card" } })),
    });
    expect(await handleAffiliateEvent(ev("invoice.paid", invoice()), d)).toBe("self_referral");
    expect(d.accrue).not.toHaveBeenCalled();
    expect(d.ownCardFingerprints).not.toHaveBeenCalled();
  });

  it("a charge with no card fingerprint skips the card check", async () => {
    const d = deps({ retrieveCharge: paidWith(null) });
    expect(await handleAffiliateEvent(ev("invoice.paid", invoice()), d)).toBe("accrued");
    expect(d.ownCardFingerprints).not.toHaveBeenCalled();
  });
});

describe("affiliate billing events", () => {
  it("a referred tenant's first paid invoice accrues 100% of month 1, anchored on the subscription's start", async () => {
    const d = deps();
    expect(await handleAffiliateEvent(ev("invoice.paid", invoice()), d)).toBe("accrued");
    const call = (d.accrue as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call).toMatchObject({ tenantId: "t1", chargeId: "ch_1", chargeAmountCents: 2000, livemode: true, anchor: new Date(ts("2026-01-31") * 1000).toISOString() });
    expect(call.entries).toEqual([expect.objectContaining({ amount_cents: 2000, month_index: 1, rate: 1, livemode: true })]);
  });
  it("out-of-band, non-USD, zero, non-subscription and unreferred invoices earn nothing", async () => {
    for (const [inv, why] of [
      [invoice({ paid_out_of_band: true }), "not_commissionable"],
      [invoice({ subscription: null }), "not_subscription"],
      [invoice({ currency: "eur" }), "not_commissionable"],
      [invoice({ amount_paid: 0 }), "not_commissionable"],
    ] as const) {
      const d = deps();
      expect(await handleAffiliateEvent(ev("invoice.paid", inv), d), why).toBe(why);
      expect(d.accrue).not.toHaveBeenCalled();
    }
  });
});

describe("invoice.paid across Stripe API versions", () => {
  const basil = (over: Record<string, unknown> = {}) => {
    const { charge: _c, subscription: _s, tax: _t, ...rest } = invoice();
    return {
      ...rest,
      parent: { type: "subscription_details", subscription_details: { subscription: "sub_1" } },
      payments: { data: [{ status: "paid", payment: { type: "charge", charge: "ch_basil" } }] },
      ...over,
    };
  };
  const accrued = (d: AffiliateEventDeps) => (d.accrue as ReturnType<typeof vi.fn>).mock.calls[0][0];

  it("a basil-shaped referred paid invoice accrues against the charge in invoice.payments", async () => {
    const d = deps();
    expect(await handleAffiliateEvent(ev("invoice.paid", basil()), d)).toBe("accrued");
    expect(accrued(d)).toMatchObject({ tenantId: "t1", chargeId: "ch_basil" });
    expect(d.retrieveSubscription).toHaveBeenCalledWith("sub_1");
    expect(d.retrieveInvoice).not.toHaveBeenCalled();
    expect(d.retrievePaymentIntent).not.toHaveBeenCalled();
  });

  it("a basil payment made by payment intent uses that intent's latest charge", async () => {
    const d = deps();
    const inv = basil({ payments: { data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: "pi_1" } }] } });
    expect(await handleAffiliateEvent(ev("invoice.paid", inv), d)).toBe("accrued");
    expect(d.retrievePaymentIntent).toHaveBeenCalledWith("pi_1");
    expect(accrued(d).chargeId).toBe("ch_pi");
  });

  it("a basil payload without payments reads the charge from the invoice through the pinned client", async () => {
    const d = deps({ retrieveInvoice: vi.fn(async () => ({ id: "in_1", charge: "ch_pinned" }) as unknown as Stripe.Invoice) });
    expect(await handleAffiliateEvent(ev("invoice.paid", basil({ payments: undefined })), d)).toBe("accrued");
    expect(d.retrieveInvoice).toHaveBeenCalledWith("in_1");
    expect(accrued(d).chargeId).toBe("ch_pinned");
  });

  it("a basil invoice the pinned read shows as paid out of band earns nothing", async () => {
    const d = deps({ retrieveInvoice: vi.fn(async () => ({ id: "in_1", charge: null, paid_out_of_band: true }) as unknown as Stripe.Invoice) });
    expect(await handleAffiliateEvent(ev("invoice.paid", basil({ payments: undefined })), d)).toBe("not_commissionable");
    expect(d.accrue).not.toHaveBeenCalled();
  });

  it("an old-shape invoice still accrues against invoice.charge with no extra Stripe reads", async () => {
    const d = deps();
    expect(await handleAffiliateEvent(ev("invoice.paid", invoice()), d)).toBe("accrued");
    expect(accrued(d).chargeId).toBe("ch_1");
    expect(d.retrieveInvoice).not.toHaveBeenCalled();
    expect(d.retrievePaymentIntent).not.toHaveBeenCalled();
  });

  it("a non-referred invoice is not_referred, whatever its shape, before any charge lookup", async () => {
    for (const inv of [invoice({ charge: null }), basil({ payments: undefined })]) {
      const d = deps({ referralFor: vi.fn(async () => null) });
      expect(await handleAffiliateEvent(ev("invoice.paid", inv), d)).toBe("not_referred");
      expect(d.retrieveInvoice).not.toHaveBeenCalled();
      expect(d.retrieveCharge).not.toHaveBeenCalled();
    }
  });

  it("a $0 referred invoice is not_commissionable", async () => {
    const d = deps();
    expect(await handleAffiliateEvent(ev("invoice.paid", basil({ amount_paid: 0, total: 0 })), d)).toBe("not_commissionable");
    expect(d.accrue).not.toHaveBeenCalled();
  });

  it("a basil invoice's tax comes from total_excluding_tax (invoice.tax is gone), so a part-paid taxed invoice is not over-credited", async () => {
    const d = deps({ retrieveCharge: vi.fn(async (id: string) => ({ id, amount: 1100, customer: "cus_1", invoice: "in_1" }) as unknown as Stripe.Charge) });
    const inv = basil({ total: 2200, amount_paid: 1100, total_excluding_tax: 2000, total_taxes: [{ amount: 200 }] });
    expect(await handleAffiliateEvent(ev("invoice.paid", inv), d)).toBe("accrued");
    expect(accrued(d).entries).toEqual([expect.objectContaining({ amount_cents: 1000 })]);
  });

  it("only the card charge earns when basil's amount_paid also counts money paid out of band", async () => {
    const d = deps({ retrieveCharge: vi.fn(async (id: string) => ({ id, amount: 1000, customer: "cus_1", invoice: "in_1" }) as unknown as Stripe.Charge) });
    expect(await handleAffiliateEvent(ev("invoice.paid", basil()), d)).toBe("accrued");
    expect(accrued(d).entries).toEqual([expect.objectContaining({ amount_cents: 1000 })]);
  });

  it("an invoice with no charge in any shape is no_charge", async () => {
    const noPinnedCharge = () => deps({ retrieveInvoice: vi.fn(async () => ({ id: "in_1", charge: null }) as unknown as Stripe.Invoice) });
    for (const inv of [invoice({ charge: null }), basil({ payments: undefined }), basil({ payments: { data: [] } })]) {
      const d = noPinnedCharge();
      expect(await handleAffiliateEvent(ev("invoice.paid", inv), d)).toBe("no_charge");
      expect(d.accrue).not.toHaveBeenCalled();
    }
  });
});

describe("affiliate billing events (continued)", () => {
  it("only our tier prices count; a discount comes off once (Stripe's amount_excluding_tax already has it)", async () => {
    const d = deps({
      listLines: vi.fn(async () => [
        line({ amount: 2000, amount_excluding_tax: 1500, discount_amounts: [{ amount: 500 }] }),
        line({ id: "il_x", price: { id: "price_some_addon" } }),
      ]),
    });
    await handleAffiliateEvent(ev("invoice.paid", invoice({ amount_paid: 1650, total: 1650, tax: 150 })), d);
    const call = (d.accrue as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.entries).toHaveLength(1);
    expect(call.entries[0].amount_cents).toBe(1500);
  });
  it("a six-month line covers six months", async () => {
    const d = deps({ listLines: vi.fn(async () => [line({ amount: 60000, amount_excluding_tax: 60000, price: { id: "price_starter_6" } })]) });
    await handleAffiliateEvent(ev("invoice.paid", invoice({ amount_paid: 60000, total: 60000 })), d);
    expect((d.accrue as ReturnType<typeof vi.fn>).mock.calls[0][0].entries).toHaveLength(6);
  });
  it("a later invoice delivered first still numbers months from the subscription's start", async () => {
    const d = deps({ listLines: vi.fn(async () => [line({ period: { start: ts("2026-03-31") } })]) });
    await handleAffiliateEvent(ev("invoice.paid", invoice()), d);
    expect((d.accrue as ReturnType<typeof vi.fn>).mock.calls[0][0].entries[0]).toMatchObject({ month_index: 3, rate: 0.3 });
  });
  it("if the referral already has an anchor, months are renumbered from it", async () => {
    const accrue = vi.fn()
      .mockResolvedValueOnce({ outcome: "anchor_moved", anchor_at: new Date(ts("2025-12-31") * 1000).toISOString() })
      .mockResolvedValueOnce({ outcome: "accrued" });
    const d = deps({ accrue });
    expect(await handleAffiliateEvent(ev("invoice.paid", invoice()), d)).toBe("accrued");
    expect(accrue.mock.calls[1][0].entries[0]).toMatchObject({ month_index: 2, rate: 1 });
  });
  it("refunds and disputes on referred subscription charges become facts; others are ignored", async () => {
    const d = deps();
    await handleAffiliateEvent(ev("charge.refunded", { id: "ch_1", amount_refunded: 700 }), d);
    expect(d.refund).toHaveBeenCalledWith("ch_1", 700);
    await handleAffiliateEvent(ev("charge.dispute.created", { id: "dp_1", charge: "ch_1", amount: 500, status: "warning_needs_response" }), d);
    expect(d.dispute).toHaveBeenLastCalledWith("dp_1", "ch_1", 500, "warning_needs_response");
    await handleAffiliateEvent(ev("charge.dispute.closed", { id: "dp_1", charge: "ch_1", amount: 500, status: "won" }), d);
    expect(d.dispute).toHaveBeenLastCalledWith("dp_1", "ch_1", 500, "won");
    const other = deps({ retrieveCharge: vi.fn(async (id: string) => ({ id, amount: 1, customer: "cus_1", invoice: null }) as unknown as Stripe.Charge) });
    expect(await handleAffiliateEvent(ev("charge.refunded", { id: "ch_9", amount_refunded: 1 }), other)).toBe("not_referred");
    expect(other.refund).not.toHaveBeenCalled();
  });
  it("a credit note counts only what was not refunded (the refund comes as charge.refunded)", async () => {
    const d = deps();
    await handleAffiliateEvent(ev("credit_note.created", { id: "cn_1", invoice: "in_1", total: 2000, refund: "re_1" }), d);
    expect(d.creditNote).toHaveBeenCalledWith("cn_1", "ch_1", 1500, false);
    await handleAffiliateEvent(ev("credit_note.voided", { id: "cn_1", invoice: "in_1", total: 2000, refund: "re_1", status: "void" }), d);
    expect(d.creditNote).toHaveBeenLastCalledWith("cn_1", "ch_1", 1500, true);
    const refundOnly = deps({ retrieveRefund: vi.fn(async () => ({ amount: 2000 }) as unknown as Stripe.Refund) });
    expect(await handleAffiliateEvent(ev("credit_note.created", { id: "cn_2", invoice: "in_1", total: 2000, refund: "re_2" }), refundOnly)).toBe("refund_only");
  });
});
