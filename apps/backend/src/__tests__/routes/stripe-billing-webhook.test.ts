
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({}) }));

import { makeStripeBillingWebhook } from "@/routes/webhooks/stripe-billing";

const TENANT = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  process.env.STRIPE_PRICE_TEAM_MONTHLY = "price_team_m";
});

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
  return res;
}
function mockReq(sig: string | null, raw = Buffer.from("{}")) {
  return { header: (h: string) => (h.toLowerCase() === "stripe-signature" ? sig : null), body: raw } as never;
}
function subEvent(over: Record<string, unknown> = {}) {
  return {
    id: "evt_1",
    type: "customer.subscription.created",
    created: 1000,
    data: {
      object: {
        id: "sub_1",
        customer: "cus_1",
        status: "active",
        cancel_at_period_end: false,
        current_period_end: 1893456000,
        items: { data: [{ price: { id: "price_team_m" } }] },
        metadata: { tenant_id: TENANT },
        ...over,
      },
    },
  };
}

const baseDeps = {
  webhookSecret: () => "whsec_test",
  constructEvent: (_p: Buffer, _s: string, _sec: string) => CURRENT_EVENT as never,
  affiliateEvent: async () => "ignored",
  eventProcessed: vi.fn(async () => false),
  markProcessed: vi.fn(async () => {}),
  resolveTenantByCustomer: vi.fn(async () => null),
  tenantExists: vi.fn(async () => true),
  readRevocation: vi.fn(async () => ({ revoked: false, subscriptionId: null })),
  clearRevocation: vi.fn(async () => ({ error: null })),
  applyState: vi.fn(async () => ({ error: null })),
  setMonthlyCredits: vi.fn(async () => ({ error: null })),
  resolvePaymentIntentForCharge: vi.fn(async () => null),
  pricingConfig: vi.fn(async () => ({ creditsPerUsd: 400, tiers: {} })),
  setTier: vi.fn(async () => ({ error: null })),
  clearTierForSubscription: vi.fn(async () => ({ error: null })),
  tierCredits: vi.fn(async () => ({ starter: 8_000, growth: 48_000, pro: 96_000 })),
  notifyPaymentFailed: vi.fn(async () => "sent"),
};
let CURRENT_EVENT: unknown;

describe("billing webhook", () => {
  it("503 when secret unset", async () => {
    const h = makeStripeBillingWebhook({ webhookSecret: () => null });
    const res = mockRes();
    await h(mockReq("sig"), res as never);
    expect(res.statusCode).toBe(503);
  });

  it("400 when signature missing", async () => {
    const h = makeStripeBillingWebhook({ webhookSecret: () => "whsec" });
    const res = mockRes();
    await h(mockReq(null), res as never);
    expect(res.statusCode).toBe(400);
  });

  it("400 on bad signature", async () => {
    const h = makeStripeBillingWebhook({
      webhookSecret: () => "whsec",
      constructEvent: () => { throw new Error("bad sig"); },
    });
    const res = mockRes();
    await h(mockReq("sig"), res as never);
    expect(res.statusCode).toBe(400);
  });

  it("200 ignores unhandled event types", async () => {
    CURRENT_EVENT = { id: "e", type: "payment_intent.created", created: 1, data: { object: {} } };
    const h = makeStripeBillingWebhook({ ...baseDeps });
    const res = mockRes();
    await h(mockReq("sig"), res as never);
    expect(res.statusCode).toBe(200);
    expect((res.body as { ignored?: string }).ignored).toBe("payment_intent.created");
  });

  it("affiliates run for invoice.paid; a failure goes to the retry worker and billing carries on", async () => {
    CURRENT_EVENT = { id: "e_inv", type: "invoice.paid", created: 1, data: { object: { id: "in_1" } } };
    const seen: string[] = [];
    const ok = makeStripeBillingWebhook({ ...baseDeps, affiliateEvent: async (e) => (seen.push(e.type), "accrued") });
    const r1 = mockRes();
    await ok(mockReq("sig"), r1 as never);
    expect(seen).toEqual(["invoice.paid"]);
    expect(r1.statusCode).toBe(200);
    const retried: string[] = [];
    const bad = makeStripeBillingWebhook({ ...baseDeps, affiliateEvent: async () => Promise.reject(new Error("db down")), affiliateRetry: async (id) => void retried.push(id) });
    const r2 = mockRes();
    await bad(mockReq("sig"), r2 as never);
    expect(r2.statusCode).toBe(200);
    expect(retried).toEqual(["e_inv"]);
    const parked: string[] = [];
    const queueDown = makeStripeBillingWebhook({
      ...baseDeps,
      affiliateEvent: async () => Promise.reject(new Error("db down")),
      affiliateRetry: async () => Promise.reject(new Error("queue down")),
      affiliatePark: async (id) => void parked.push(id),
    });
    const r3 = mockRes();
    await queueDown(mockReq("sig"), r3 as never);
    expect(r3.statusCode).toBe(200);
    expect(parked).toEqual(["e_inv"]);
    const worse = makeStripeBillingWebhook({
      ...baseDeps,
      affiliateEvent: async () => Promise.reject(new Error("db down")),
      affiliateRetry: async () => Promise.reject(new Error("queue down")),
      affiliatePark: async () => Promise.reject(new Error("db down")),
    });
    const r4 = mockRes();
    await worse(mockReq("sig"), r4 as never);
    expect(r4.statusCode).toBe(500);
  });

  it("200 + dedupes an already-processed event", async () => {
    CURRENT_EVENT = subEvent();
    const h = makeStripeBillingWebhook({ ...baseDeps, eventProcessed: async () => true });
    const res = mockRes();
    await h(mockReq("sig"), res as never);
    expect((res.body as { duplicate?: string }).duplicate).toBe("evt_1");
  });

  it("applies a new team subscription, then records the event id AFTER apply", async () => {
    CURRENT_EVENT = subEvent();
    const apply = vi.fn(async () => ({ error: null }));
    const mark = vi.fn(async () => {});
    const h = makeStripeBillingWebhook({ ...baseDeps, applyState: apply, markProcessed: mark });
    const res = mockRes();
    await h(mockReq("sig"), res as never);
    expect(res.statusCode).toBe(200);
    expect(apply).toHaveBeenCalledOnce();
    const args = (apply.mock.calls[0] as unknown[])[0] as { tenant_id: string; plan: string; status: string; event_created: number };
    expect(args).toMatchObject({ tenant_id: TENANT, plan: "team", status: "active", event_created: 1000 });
    expect(mark).toHaveBeenCalledOnce();
  });

  it("subscription event with an UNKNOWN price → 503 (Stripe retries): no apply, no tier, no grant, NOT recorded", async () => {
    CURRENT_EVENT = subEvent({ items: { data: [{ price: { id: "price_unmapped" } }] } });
    const apply = vi.fn(async () => ({ error: null }));
    const mark = vi.fn(async () => {});
    const setTier = vi.fn(async () => ({ error: null }));
    const setMc = vi.fn(async () => ({ error: null }));
    const alertStaff = vi.fn(async () => {});
    const h = makeStripeBillingWebhook({
      ...baseDeps, applyState: apply, markProcessed: mark, setTier, setMonthlyCredits: setMc, alertStaff,
    });
    const res = mockRes();
    await h(mockReq("sig"), res as never);
    expect(res.statusCode).toBe(503);
    expect(alertStaff).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "billing_webhook_unknown_price",
        email: expect.objectContaining({ dedupeKey: expect.stringMatching(/^billing-webhook:unknown_price:/) }),
      }),
    );
    expect(apply).not.toHaveBeenCalled();
    expect(setTier).not.toHaveBeenCalled();
    expect(setMc).not.toHaveBeenCalled();
    expect(mark).not.toHaveBeenCalled();
  });

  it("subscription.deleted → status canceled, plan FREE (not the price's paid plan)", async () => {
    CURRENT_EVENT = subEvent({ status: "canceled" });
    (CURRENT_EVENT as { type: string }).type = "customer.subscription.deleted";
    const apply = vi.fn(async () => ({ error: null }));
    const h = makeStripeBillingWebhook({ ...baseDeps, applyState: apply });
    const res = mockRes();
    await h(mockReq("sig"), res as never);
    expect(res.statusCode).toBe(200);
    expect((apply.mock.calls[0] as unknown[])[0]).toMatchObject({ status: "canceled", plan: "free" });
  });

  it("credit-ladder subscription.deleted → plan FREE (was 'team' = 80k/mo forever, audit #9)", async () => {
    process.env.STRIPE_PRICE_CREDITS_UNIT = "price_credits_unit";
    CURRENT_EVENT = subEvent({
      status: "canceled",
      items: { data: [{ price: { id: "price_credits_unit" }, quantity: 80 }] },
    });
    (CURRENT_EVENT as { type: string }).type = "customer.subscription.deleted";
    const apply = vi.fn(async () => ({ error: null }));
    const setCredits = vi.fn(async () => ({ error: null }));
    const h = makeStripeBillingWebhook({ ...baseDeps, applyState: apply, setMonthlyCredits: setCredits });
    const res = mockRes();
    await h(mockReq("sig"), res as never);
    expect(res.statusCode).toBe(200);
    expect((apply.mock.calls[0] as unknown[])[0]).toMatchObject({ status: "canceled", plan: "free" });
    expect(setCredits).toHaveBeenCalledWith(TENANT, null, null, 1000);
    delete process.env.STRIPE_PRICE_CREDITS_UNIT;
  });

  it("a cancel on an UNMAPPED price or a zero-quantity ladder item still applies (no 503 loop)", async () => {
    process.env.STRIPE_PRICE_CREDITS_UNIT = "price_credits_unit";
    for (const items of [
      { data: [{ price: { id: "price_retired" } }] },
      { data: [{ price: { id: "price_credits_unit" }, quantity: 0 }] },
    ]) {
      CURRENT_EVENT = subEvent({ status: "canceled", items });
      (CURRENT_EVENT as { type: string }).type = "customer.subscription.deleted";
      const apply = vi.fn(async () => ({ error: null }));
      const h = makeStripeBillingWebhook({ ...baseDeps, applyState: apply });
      const res = mockRes();
      await h(mockReq("sig"), res as never);
      expect(res.statusCode).toBe(200);
      expect((apply.mock.calls[0] as unknown[])[0]).toMatchObject({ status: "canceled", plan: "free" });
    }
    delete process.env.STRIPE_PRICE_CREDITS_UNIT;
  });

  it("subscription.updated with status canceled → plan FREE too", async () => {
    CURRENT_EVENT = subEvent({ status: "canceled" });
    (CURRENT_EVENT as { type: string }).type = "customer.subscription.updated";
    const apply = vi.fn(async () => ({ error: null }));
    const h = makeStripeBillingWebhook({ ...baseDeps, applyState: apply });
    const res = mockRes();
    await h(mockReq("sig"), res as never);
    expect((apply.mock.calls[0] as unknown[])[0]).toMatchObject({ status: "canceled", plan: "free" });
  });

  it("period end: reads the top-level current_period_end (older API shape)", async () => {
    CURRENT_EVENT = subEvent({ current_period_end: 1893456000 });
    const apply = vi.fn(async () => ({ error: null }));
    const h = makeStripeBillingWebhook({ ...baseDeps, applyState: apply });
    await h(mockReq("sig"), mockRes() as never);
    expect((apply.mock.calls[0] as unknown[])[0]).toMatchObject({
      current_period_end: new Date(1893456000 * 1000).toISOString(),
    });
  });

  it("period end: falls back to items.data[0].current_period_end (newer API shape)", async () => {
    CURRENT_EVENT = subEvent({
      current_period_end: undefined,
      items: { data: [{ price: { id: "price_team_m" }, current_period_end: 1900000000 }] },
    });
    const apply = vi.fn(async () => ({ error: null }));
    const h = makeStripeBillingWebhook({ ...baseDeps, applyState: apply });
    await h(mockReq("sig"), mockRes() as never);
    expect((apply.mock.calls[0] as unknown[])[0]).toMatchObject({
      current_period_end: new Date(1900000000 * 1000).toISOString(),
    });
  });

  it("period end: null when neither shape carries it", async () => {
    CURRENT_EVENT = subEvent({ current_period_end: undefined });
    const apply = vi.fn(async () => ({ error: null }));
    const h = makeStripeBillingWebhook({ ...baseDeps, applyState: apply });
    await h(mockReq("sig"), mockRes() as never);
    expect((apply.mock.calls[0] as unknown[])[0]).toMatchObject({ current_period_end: null });
  });

  it("503 (retry) when tenant cannot be resolved", async () => {
    CURRENT_EVENT = subEvent({ metadata: {} });
    const h = makeStripeBillingWebhook({
      ...baseDeps,
      resolveTenantByCustomer: async () => null,
    });
    const res = mockRes();
    await h(mockReq("sig"), res as never);
    expect(res.statusCode).toBe(503);
  });

  it("prefers the stored customer binding over metadata", async () => {
    CURRENT_EVENT = subEvent({ metadata: { tenant_id: "99999999-9999-9999-9999-999999999999" } });
    const apply = vi.fn(async () => ({ error: null }));
    const h = makeStripeBillingWebhook({
      ...baseDeps,
      applyState: apply,
      resolveTenantByCustomer: async () => TENANT,
    });
    const res = mockRes();
    await h(mockReq("sig"), res as never);
    expect(((apply.mock.calls[0] as unknown[])[0] as { tenant_id: string }).tenant_id).toBe(TENANT);
  });

  it("invoice.payment_failed without a resolvable plan → 200 no-plan-skip", async () => {
    CURRENT_EVENT = {
      id: "evt_inv", type: "invoice.payment_failed", created: 2000,
      data: { object: { customer: "cus_1", metadata: { tenant_id: TENANT } } },
    };
    const apply = vi.fn(async () => ({ error: null }));
    const h = makeStripeBillingWebhook({ ...baseDeps, applyState: apply });
    const res = mockRes();
    await h(mockReq("sig"), res as never);
    expect(res.statusCode).toBe(200);
    expect(apply).not.toHaveBeenCalled();
  });

  it("invoice.payment_failed emails the customer + Ravi with the invoice facts, writes no plan, and records the event", async () => {
    CURRENT_EVENT = {
      id: "evt_inv_fail", type: "invoice.payment_failed", created: 2000,
      data: { object: {
        id: "in_123", customer: "cus_1", subscription: "sub_1", amount_due: 24000, currency: "usd",
        attempt_count: 2, billing_reason: "subscription_cycle", metadata: {},
      } },
    };
    const apply = vi.fn(async () => ({ error: null }));
    const setTier = vi.fn(async () => ({ error: null }));
    const mark = vi.fn(async () => {});
    const notify = vi.fn(async () => "sent");
    const h = makeStripeBillingWebhook({
      ...baseDeps, applyState: apply, setTier, markProcessed: mark, notifyPaymentFailed: notify,
      resolveTenantByCustomer: async () => TENANT,
      readRevocation: async () => ({ revoked: false, subscriptionId: "sub_1" }),
    });
    const res = mockRes();
    await h(mockReq("sig"), res as never);
    expect(res.statusCode).toBe(200);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      tenantId: TENANT, invoiceId: "in_123", amountDueCents: 24000, currency: "usd",
      attemptCount: 2, billingReason: "subscription_cycle",
    });
    expect(apply).not.toHaveBeenCalled();
    expect(setTier).not.toHaveBeenCalled();
    expect(mark).toHaveBeenCalledWith("evt_inv_fail", "invoice.payment_failed");
  });

  it("invoice.payment_failed whose email fails → 500 and NOT recorded, so Stripe redelivers", async () => {
    CURRENT_EVENT = {
      id: "evt_inv_fail2", type: "invoice.payment_failed", created: 2000,
      data: { object: { id: "in_456", customer: "cus_1", subscription: "sub_1", amount_due: 2000, currency: "usd", metadata: {} } },
    };
    const mark = vi.fn(async () => {});
    const h = makeStripeBillingWebhook({
      ...baseDeps, markProcessed: mark,
      notifyPaymentFailed: vi.fn(async () => { throw new Error("sendgrid down"); }),
      resolveTenantByCustomer: async () => TENANT,
      readRevocation: async () => ({ revoked: false, subscriptionId: "sub_1" }),
    });
    const res = mockRes();
    await h(mockReq("sig"), res as never);
    expect(res.statusCode).toBe(500);
    expect(mark).not.toHaveBeenCalled();
  });

  it.each([
    ["an OLD subscription's invoice", { subscription: "sub_old", billing_reason: "subscription_cycle" }],
    ["a one-off invoice (no subscription)", { billing_reason: "manual" }],
    ["a failed FIRST payment (shown live at checkout)", { subscription: "sub_1", billing_reason: "subscription_create" }],
  ])("invoice.payment_failed for %s → no email, still acked + recorded", async (_name, over) => {
    CURRENT_EVENT = {
      id: "evt_inv_skip", type: "invoice.payment_failed", created: 2000,
      data: { object: { id: "in_789", customer: "cus_1", amount_due: 2000, currency: "usd", metadata: {}, ...over } },
    };
    const mark = vi.fn(async () => {});
    const notify = vi.fn(async () => "sent");
    const h = makeStripeBillingWebhook({
      ...baseDeps, markProcessed: mark, notifyPaymentFailed: notify,
      resolveTenantByCustomer: async () => TENANT,
      readRevocation: async () => ({ revoked: false, subscriptionId: "sub_1" }),
    });
    const res = mockRes();
    await h(mockReq("sig"), res as never);
    expect(res.statusCode).toBe(200);
    expect(notify).not.toHaveBeenCalled();
    expect(mark).toHaveBeenCalledWith("evt_inv_skip", "invoice.payment_failed");
  });

  it("invoice.payment_failed on the newer Stripe API (subscription under parent) still emails", async () => {
    CURRENT_EVENT = {
      id: "evt_inv_basil", type: "invoice.payment_failed", created: 2000,
      data: { object: {
        id: "in_b", customer: "cus_1", amount_due: 12000, currency: "usd", billing_reason: "subscription_cycle",
        parent: { subscription_details: { subscription: "sub_1" } }, metadata: {},
      } },
    };
    const notify = vi.fn(async () => "sent");
    const h = makeStripeBillingWebhook({
      ...baseDeps, notifyPaymentFailed: notify,
      resolveTenantByCustomer: async () => TENANT,
      readRevocation: async () => ({ revoked: false, subscriptionId: "sub_1" }),
    });
    const res = mockRes();
    await h(mockReq("sig"), res as never);
    expect(res.statusCode).toBe(200);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ invoiceId: "in_b" }));
  });

  it("credit-ladder sub (unit price) → applies plan=team + grants the BILLED quantity volume (with event watermark)", async () => {
    process.env.STRIPE_PRICE_CREDITS_UNIT = "price_credits_unit";
    CURRENT_EVENT = subEvent({
      items: { data: [{ price: { id: "price_credits_unit" }, quantity: 80 }] },
      metadata: { tenant_id: TENANT, monthly_credits: "80000" },
    });
    const apply = vi.fn(async () => ({ error: null }));
    const setCredits = vi.fn(async () => ({ error: null }));
    const h = makeStripeBillingWebhook({ ...baseDeps, applyState: apply, setMonthlyCredits: setCredits });
    const res = mockRes();
    await h(mockReq("sig"), res as never);
    expect(res.statusCode).toBe(200);
    expect(((apply.mock.calls[0] as unknown[])[0] as { plan: string }).plan).toBe("team");
    expect(setCredits).toHaveBeenCalledWith(TENANT, 80000, 200, 1000);
    delete process.env.STRIPE_PRICE_CREDITS_UNIT;
  });

  it("S5/P1.7: billed quantity is authoritative — stale metadata is IGNORED", async () => {
    process.env.STRIPE_PRICE_CREDITS_UNIT = "price_credits_unit";
    CURRENT_EVENT = subEvent({
      items: { data: [{ price: { id: "price_credits_unit" }, quantity: 20 }] },
      metadata: { tenant_id: TENANT, monthly_credits: "12000000" },
    });
    const setCredits = vi.fn(async () => ({ error: null }));
    const h = makeStripeBillingWebhook({ ...baseDeps, setMonthlyCredits: setCredits });
    const res = mockRes();
    await h(mockReq("sig"), res as never);
    expect(setCredits).toHaveBeenCalledWith(TENANT, 20000, 50, 1000);
    delete process.env.STRIPE_PRICE_CREDITS_UNIT;
  });

  it("S5: ladder price with NO billable quantity → 503 fail-closed (no grant from metadata)", async () => {
    process.env.STRIPE_PRICE_CREDITS_UNIT = "price_credits_unit";
    CURRENT_EVENT = subEvent({
      items: { data: [{ price: { id: "price_credits_unit" } }] },
      metadata: { tenant_id: TENANT, monthly_credits: "80000" },
    });
    const setCredits = vi.fn(async () => ({ error: null }));
    const h = makeStripeBillingWebhook({ ...baseDeps, setMonthlyCredits: setCredits });
    const res = mockRes();
    await h(mockReq("sig"), res as never);
    expect(res.statusCode).toBe(503);
    expect(setCredits).not.toHaveBeenCalled();
    delete process.env.STRIPE_PRICE_CREDITS_UNIT;
  });

  it("S5/P2.b: ladder sub past_due → does NOT refresh the grant (withhold)", async () => {
    process.env.STRIPE_PRICE_CREDITS_UNIT = "price_credits_unit";
    CURRENT_EVENT = subEvent({
      status: "past_due",
      items: { data: [{ price: { id: "price_credits_unit" }, quantity: 80 }] },
      metadata: { tenant_id: TENANT },
    });
    const setCredits = vi.fn(async () => ({ error: null }));
    const h = makeStripeBillingWebhook({ ...baseDeps, setMonthlyCredits: setCredits });
    const res = mockRes();
    await h(mockReq("sig"), res as never);
    expect(res.statusCode).toBe(200);
    expect(setCredits).not.toHaveBeenCalled();
    delete process.env.STRIPE_PRICE_CREDITS_UNIT;
  });

  it("S5/P2.a: switch ladder → legacy plan clears the stale override (null)", async () => {
    process.env.STRIPE_PRICE_CREDITS_UNIT = "price_credits_unit";
    CURRENT_EVENT = subEvent({
      status: "active",
      items: { data: [{ price: { id: "price_team_m" } }] },
      metadata: { tenant_id: TENANT },
    });
    const setCredits = vi.fn(async () => ({ error: null }));
    const h = makeStripeBillingWebhook({ ...baseDeps, setMonthlyCredits: setCredits });
    const res = mockRes();
    await h(mockReq("sig"), res as never);
    expect(setCredits).toHaveBeenCalledWith(TENANT, null, null, 1000);
    delete process.env.STRIPE_PRICE_CREDITS_UNIT;
  });

  it("credit-ladder subscription.deleted → clears the granted volume (null, watermark)", async () => {
    process.env.STRIPE_PRICE_CREDITS_UNIT = "price_credits_unit";
    CURRENT_EVENT = subEvent({
      status: "canceled",
      items: { data: [{ price: { id: "price_credits_unit" }, quantity: 80 }] },
      metadata: { tenant_id: TENANT, monthly_credits: "80000" },
    });
    (CURRENT_EVENT as { type: string }).type = "customer.subscription.deleted";
    const setCredits = vi.fn(async () => ({ error: null }));
    const h = makeStripeBillingWebhook({ ...baseDeps, setMonthlyCredits: setCredits });
    const res = mockRes();
    await h(mockReq("sig"), res as never);
    expect(setCredits).toHaveBeenCalledWith(TENANT, null, null, 1000);
    delete process.env.STRIPE_PRICE_CREDITS_UNIT;
  });

  it("the SAME billed quantity grants more credits after staff raise the rate", async () => {
    process.env.STRIPE_PRICE_CREDITS_UNIT = "price_credits_unit";
    CURRENT_EVENT = subEvent({
      items: { data: [{ price: { id: "price_credits_unit" }, quantity: 20 }] },
      metadata: { tenant_id: TENANT },
    });
    const setCredits = vi.fn(async () => ({ error: null }));
    const h = makeStripeBillingWebhook({
      ...baseDeps,
      setMonthlyCredits: setCredits,
      pricingConfig: vi.fn(async () => ({ creditsPerUsd: 1000, tiers: {} })),
    });
    const res = mockRes();
    await h(mockReq("sig"), res as never);
    expect(res.statusCode).toBe(200);
    expect(setCredits).toHaveBeenCalledWith(TENANT, 50000, 50, 1000);
    delete process.env.STRIPE_PRICE_CREDITS_UNIT;
  });

  it("grants off the price object's OWN unit amount when Stripe sends one", async () => {
    process.env.STRIPE_PRICE_CREDITS_UNIT = "price_credits_unit";
    CURRENT_EVENT = subEvent({
      items: { data: [{ price: { id: "price_credits_unit", unit_amount: 500 }, quantity: 20 }] },
      metadata: { tenant_id: TENANT },
    });
    const setCredits = vi.fn(async () => ({ error: null }));
    const h = makeStripeBillingWebhook({ ...baseDeps, setMonthlyCredits: setCredits });
    const res = mockRes();
    await h(mockReq("sig"), res as never);
    expect(setCredits).toHaveBeenCalledWith(TENANT, 40000, 100, 1000);
    delete process.env.STRIPE_PRICE_CREDITS_UNIT;
  });

  it("an unreadable sell rate 503s the grant instead of guessing a default", async () => {
    process.env.STRIPE_PRICE_CREDITS_UNIT = "price_credits_unit";
    CURRENT_EVENT = subEvent({
      items: { data: [{ price: { id: "price_credits_unit" }, quantity: 20 }] },
      metadata: { tenant_id: TENANT },
    });
    const setCredits = vi.fn(async () => ({ error: null }));
    const h = makeStripeBillingWebhook({
      ...baseDeps,
      setMonthlyCredits: setCredits,
      pricingConfig: vi.fn(async () => {
        throw new Error("system_config read failed");
      }),
    });
    const res = mockRes();
    await h(mockReq("sig"), res as never);
    expect(res.statusCode).toBe(503);
    expect(setCredits).not.toHaveBeenCalled();
    delete process.env.STRIPE_PRICE_CREDITS_UNIT;
  });

  it("a PER-TIER override beats the linear rate for that rung only", async () => {
    process.env.STRIPE_PRICE_CREDITS_UNIT = "price_credits_unit";
    CURRENT_EVENT = subEvent({
      items: { data: [{ price: { id: "price_credits_unit" }, quantity: 20 }] },
      metadata: { tenant_id: TENANT },
    });
    const setCredits = vi.fn(async () => ({ error: null }));
    const h = makeStripeBillingWebhook({
      ...baseDeps,
      setMonthlyCredits: setCredits,
      pricingConfig: vi.fn(async () => ({ creditsPerUsd: 400, tiers: { 50: 25_000 } })),
    });
    await h(mockReq("sig"), mockRes() as never);
    expect(setCredits).toHaveBeenCalledWith(TENANT, 25_000, 50, 1000);
    delete process.env.STRIPE_PRICE_CREDITS_UNIT;
  });

  it("an OFF-ladder Portal quantity records NO tier and prices at the linear rate", async () => {
    process.env.STRIPE_PRICE_CREDITS_UNIT = "price_credits_unit";
    CURRENT_EVENT = subEvent({
      items: { data: [{ price: { id: "price_credits_unit" }, quantity: 21 }] },
      metadata: { tenant_id: TENANT },
    });
    const setCredits = vi.fn(async () => ({ error: null }));
    const h = makeStripeBillingWebhook({
      ...baseDeps,
      setMonthlyCredits: setCredits,
      pricingConfig: vi.fn(async () => ({ creditsPerUsd: 400, tiers: { 50: 25_000 } })),
    });
    await h(mockReq("sig"), mockRes() as never);
    expect(setCredits).toHaveBeenCalledWith(TENANT, 21_000, null, 1000);
    delete process.env.STRIPE_PRICE_CREDITS_UNIT;
  });

  function topupSession(over: Record<string, unknown> = {}) {
    return {
      id: "evt_topup",
      type: "checkout.session.completed",
      created: 3000,
      data: {
        object: {
          id: "cs_1",
          mode: "payment",
          customer: "cus_1",
          payment_intent: "pi_1",
          payment_status: "paid",
          currency: "usd",
          amount_total: 2000,
          metadata: { kind: "credit_topup", tenant_id: TENANT, credits: "8000" },
          ...over,
        },
      },
    };
  }

  it.each([
    [2000, 8_000],
    [12000, 48_000],
    [24000, 96_000],
  ])("top-up pack of %i cents grants that tier's configured pool (%i)", async (cents, credits) => {
    CURRENT_EVENT = topupSession({ amount_total: cents });
    const topup = vi.fn(async () => ({ error: null }));
    const h = makeStripeBillingWebhook({ ...baseDeps, applyCreditTopup: topup });
    const res = mockRes();
    await h(mockReq("sig"), res as never);
    expect(res.statusCode).toBe(200);
    expect(topup).toHaveBeenCalledWith(TENANT, credits, "pi_1", "evt_topup");
  });

  it("top-up credits follow LIVE tier_credits config, not a constant", async () => {
    CURRENT_EVENT = topupSession({ amount_total: 12000 });
    const topup = vi.fn(async () => ({ error: null }));
    const h = makeStripeBillingWebhook({
      ...baseDeps,
      applyCreditTopup: topup,
      tierCredits: vi.fn(async () => ({ starter: 1, growth: 55_555, pro: 3 })),
    });
    await h(mockReq("sig"), mockRes() as never);
    expect(topup).toHaveBeenCalledWith(TENANT, 55_555, "pi_1", "evt_topup");
  });

  it("top-up IGNORES a tampered metadata credit claim — only the amount paid counts", async () => {
    CURRENT_EVENT = topupSession({
      metadata: { kind: "credit_topup", tenant_id: TENANT, credits: "12000000" },
    });
    const topup = vi.fn(async () => ({ error: null }));
    const h = makeStripeBillingWebhook({ ...baseDeps, applyCreditTopup: topup });
    const res = mockRes();
    await h(mockReq("sig"), res as never);
    expect(topup).toHaveBeenCalledWith(TENANT, 8_000, "pi_1", "evt_topup");
  });

  it.each([5000, 4999, 2001, 0, 100_000])(
    "top-up rejects a paid amount that is not a pack (%i cents): acked, NOT granted",
    async (cents) => {
      CURRENT_EVENT = topupSession({ amount_total: cents });
      const topup = vi.fn(async () => ({ error: null }));
      const mark = vi.fn(async () => {});
      const h = makeStripeBillingWebhook({ ...baseDeps, applyCreditTopup: topup, markProcessed: mark });
      const res = mockRes();
      await h(mockReq("sig"), res as never);
      expect(res.statusCode).toBe(200);
      expect((res.body as { note?: string }).note).toBe("topup-validation-rejected");
      expect(topup).not.toHaveBeenCalled();
    },
  );

  it("top-up 503s (no grant, no record) when tier_credits config is unreadable", async () => {
    CURRENT_EVENT = topupSession();
    const topup = vi.fn(async () => ({ error: null }));
    const mark = vi.fn(async () => {});
    const h = makeStripeBillingWebhook({
      ...baseDeps,
      applyCreditTopup: topup,
      markProcessed: mark,
      tierCredits: vi.fn(async () => { throw new Error("db down"); }),
    });
    const res = mockRes();
    await h(mockReq("sig"), res as never);
    expect(res.statusCode).toBe(503);
    expect(topup).not.toHaveBeenCalled();
    expect(mark).not.toHaveBeenCalled();
  });

  it("top-up rejects an unsettled or non-USD session", async () => {
    for (const over of [{ payment_status: "unpaid" }, { currency: "eur" }, { payment_intent: null }]) {
      CURRENT_EVENT = topupSession(over);
      const topup = vi.fn(async () => ({ error: null }));
      const h = makeStripeBillingWebhook({ ...baseDeps, applyCreditTopup: topup });
      await h(mockReq("sig"), mockRes() as never);
      expect(topup).not.toHaveBeenCalled();
    }
  });

  it("full charge.refunded on the granting sub → revokes credits + records event", async () => {
    CURRENT_EVENT = {
      id: "evt_refund", type: "charge.refunded", created: 3000,
      data: { object: { id: "ch_1", customer: "cus_1", refunded: true, invoice: "in_1" } },
    };
    const revoke = vi.fn(async () => ({ error: null, applied: true }));
    const mark = vi.fn(async () => {});
    const h = makeStripeBillingWebhook({
      ...baseDeps,
      resolveTenantByCustomer: async () => TENANT,
      resolveSubscriptionForCharge: async () => "sub_1",
      revokeCredits: revoke,
      markProcessed: mark,
    });
    const res = mockRes();
    await h(mockReq("sig"), res as never);
    expect(res.statusCode).toBe(200);
    expect(revoke).toHaveBeenCalledWith(TENANT, 3000, "sub_1");
    expect(mark).toHaveBeenCalledOnce();
  });

  it("PARTIAL charge.refunded (refunded=false) → does NOT revoke (no wrongful downgrade), still records", async () => {
    CURRENT_EVENT = {
      id: "evt_partial", type: "charge.refunded", created: 3050,
      data: { object: { id: "ch_2", customer: "cus_1", refunded: false, invoice: "in_2" } },
    };
    const revoke = vi.fn(async () => ({ error: null, applied: true }));
    const resolveSub = vi.fn(async () => "sub_1");
    const mark = vi.fn(async () => {});
    const h = makeStripeBillingWebhook({
      ...baseDeps,
      resolveTenantByCustomer: async () => TENANT,
      resolveSubscriptionForCharge: resolveSub,
      revokeCredits: revoke,
      markProcessed: mark,
    });
    const res = mockRes();
    await h(mockReq("sig"), res as never);
    expect(res.statusCode).toBe(200);
    expect((res.body as { note?: string }).note).toBe("partial-refund-skipped");
    expect(revoke).not.toHaveBeenCalled();
    expect(resolveSub).not.toHaveBeenCalled();
    expect(mark).toHaveBeenCalledOnce();
  });

  it("full refund of an UNRELATED (non-subscription) charge → skip, no revoke, still records", async () => {
    CURRENT_EVENT = {
      id: "evt_unrelated", type: "charge.refunded", created: 3060,
      data: { object: { id: "ch_3", customer: "cus_1", refunded: true } },
    };
    const revoke = vi.fn(async () => ({ error: null, applied: true }));
    const mark = vi.fn(async () => {});
    const h = makeStripeBillingWebhook({
      ...baseDeps,
      resolveTenantByCustomer: async () => TENANT,
      resolveSubscriptionForCharge: async () => null,
      resolvePaymentIntentForCharge: async () => null,
      revokeCredits: revoke,
      markProcessed: mark,
    });
    const res = mockRes();
    await h(mockReq("sig"), res as never);
    expect(res.statusCode).toBe(200);
    expect((res.body as { note?: string }).note).toBe("unrelated-charge-skipped");
    expect(revoke).not.toHaveBeenCalled();
    expect(mark).toHaveBeenCalledOnce();
  });

  it("refund of a DIFFERENT subscription → RPC no-ops (applied=false), 200 mismatch note", async () => {
    CURRENT_EVENT = {
      id: "evt_mismatch", type: "charge.refunded", created: 3070,
      data: { object: { id: "ch_4", customer: "cus_1", refunded: true, invoice: "in_4" } },
    };
    const revoke = vi.fn(async () => ({ error: null, applied: false }));
    const h = makeStripeBillingWebhook({
      ...baseDeps,
      resolveTenantByCustomer: async () => TENANT,
      resolveSubscriptionForCharge: async () => "sub_old",
      revokeCredits: revoke,
    });
    const res = mockRes();
    await h(mockReq("sig"), res as never);
    expect(res.statusCode).toBe(200);
    expect(revoke).toHaveBeenCalledWith(TENANT, 3070, "sub_old");
    expect((res.body as { note?: string }).note).toBe("subscription-mismatch-skipped");
  });

  it("charge.dispute.created (no customer on object) → resolves customer + sub via the charge, then revokes", async () => {
    CURRENT_EVENT = {
      id: "evt_dispute", type: "charge.dispute.created", created: 3100,
      data: { object: { id: "dp_1", charge: "ch_9" } },
    };
    const revoke = vi.fn(async () => ({ error: null, applied: true }));
    const h = makeStripeBillingWebhook({
      ...baseDeps,
      resolveCustomerForCharge: async () => "cus_9",
      resolveTenantByCustomer: async (c: string) => (c === "cus_9" ? TENANT : null),
      resolveSubscriptionForCharge: async (ch: string) => (ch === "ch_9" ? "sub_9" : null),
      revokeCredits: revoke,
    });
    const res = mockRes();
    await h(mockReq("sig"), res as never);
    expect(res.statusCode).toBe(200);
    expect(revoke).toHaveBeenCalledWith(TENANT, 3100, "sub_9");
  });

  it("dispute with an unresolvable tenant → 503 retry, no revoke, no record", async () => {
    CURRENT_EVENT = {
      id: "evt_dispute2", type: "charge.dispute.created", created: 3200,
      data: { object: { id: "dp_2", charge: "ch_x" } },
    };
    const revoke = vi.fn(async () => ({ error: null, applied: true }));
    const mark = vi.fn(async () => {});
    const h = makeStripeBillingWebhook({
      ...baseDeps,
      resolveCustomerForCharge: async () => null,
      resolveTenantByCustomer: async () => null,
      revokeCredits: revoke,
      markProcessed: mark,
    });
    const res = mockRes();
    await h(mockReq("sig"), res as never);
    expect(res.statusCode).toBe(503);
    expect(revoke).not.toHaveBeenCalled();
    expect(mark).not.toHaveBeenCalled();
  });
});

describe("billing webhook: live store plan", () => {
  it("pages staff when a LIVE Stripe subscription is skipped, and writes no tier or credits", async () => {
    CURRENT_EVENT = subEvent();
    const alertStaff = vi.fn(async () => {});
    const setTier = vi.fn(async () => ({ error: null }));
    const setMonthlyCredits = vi.fn(async () => ({ error: null }));
    const mark = vi.fn(async () => {});
    const h = makeStripeBillingWebhook({
      ...baseDeps,
      resolveTenantByCustomer: vi.fn(async () => TENANT),
      applyState: vi.fn(async () => ({ error: null, outcome: "store_active" })),
      alertStaff,
      setTier,
      setMonthlyCredits,
      markProcessed: mark,
    });
    const res = mockRes();
    await h(mockReq("sig"), res as never);
    expect(res.statusCode).toBe(200);
    expect(alertStaff).toHaveBeenCalledTimes(1);
    expect(alertStaff).toHaveBeenCalledWith(
      expect.objectContaining({ code: "stripe_skipped_store_active", tenant_id: TENANT }),
    );
    expect(setTier).not.toHaveBeenCalled();
    expect(setMonthlyCredits).not.toHaveBeenCalled();
    expect(mark).toHaveBeenCalledWith("evt_1", "customer.subscription.created");
  });

  it("treats a live Shopify plan the same way: pages staff, writes no tier or credits", async () => {
    CURRENT_EVENT = subEvent();
    const alertStaff = vi.fn(async () => {});
    const setTier = vi.fn(async () => ({ error: null }));
    const setMonthlyCredits = vi.fn(async () => ({ error: null }));
    const h = makeStripeBillingWebhook({
      ...baseDeps,
      resolveTenantByCustomer: vi.fn(async () => TENANT),
      applyState: vi.fn(async () => ({ error: null, outcome: "shopify_active" })),
      alertStaff,
      setTier,
      setMonthlyCredits,
    });
    const res = mockRes();
    await h(mockReq("sig"), res as never);
    expect(res.statusCode).toBe(200);
    expect(alertStaff).toHaveBeenCalledWith(expect.objectContaining({ msg: expect.stringContaining("live Shopify plan") }));
    expect(setTier).not.toHaveBeenCalled();
    expect(setMonthlyCredits).not.toHaveBeenCalled();
  });

  it("does not page for a finished Stripe subscription ending after the store took over", async () => {
    CURRENT_EVENT = { ...subEvent({ status: "canceled" }), type: "customer.subscription.deleted" };
    const alertStaff = vi.fn(async () => {});
    const setMonthlyCredits = vi.fn(async () => ({ error: null }));
    const h = makeStripeBillingWebhook({
      ...baseDeps,
      resolveTenantByCustomer: vi.fn(async () => TENANT),
      applyState: vi.fn(async () => ({ error: null, outcome: "store_active" })),
      alertStaff,
      setMonthlyCredits,
    });
    const res = mockRes();
    await h(mockReq("sig"), res as never);
    expect(res.statusCode).toBe(200);
    expect(alertStaff).not.toHaveBeenCalled();
    expect(setMonthlyCredits).not.toHaveBeenCalled();
  });

  it("an applied write never pages", async () => {
    CURRENT_EVENT = subEvent();
    const alertStaff = vi.fn(async () => {});
    const h = makeStripeBillingWebhook({
      ...baseDeps,
      resolveTenantByCustomer: vi.fn(async () => TENANT),
      applyState: vi.fn(async () => ({ error: null, outcome: "applied" })),
      alertStaff,
    });
    const res = mockRes();
    await h(mockReq("sig"), res as never);
    expect(res.statusCode).toBe(200);
    expect(alertStaff).not.toHaveBeenCalled();
  });
});

describe("billing webhook: creator-marketplace charges belong to the creator webhook", () => {
  const creatorPi = async () => ({
    id: "pi_creator",
    isTopup: false,
    isStartupOffer: false,
    tenantHint: null,
    isCreatorOrder: true,
  });

  it.each([
    ["charge.refunded", { id: "ch_cr", refunded: true }],
    ["charge.dispute.created", { id: "dp_cr", charge: "ch_cr" }],
    ["charge.dispute.funds_withdrawn", { id: "dp_cr", charge: "ch_cr" }],
  ])("%s on a creator job charge → 200 ignored, no tenant lookup, no revoke, recorded", async (type, object) => {
    CURRENT_EVENT = { id: `evt_${type}`, type, created: 4000, data: { object } };
    const revoke = vi.fn(async () => ({ error: null, applied: true }));
    const resolveCustomer = vi.fn(async () => null);
    const mark = vi.fn(async () => {});
    const h = makeStripeBillingWebhook({
      ...baseDeps,
      resolvePaymentIntentForCharge: creatorPi,
      resolveCustomerForCharge: resolveCustomer,
      revokeCredits: revoke,
      markProcessed: mark,
    });
    const res = mockRes();
    await h(mockReq("sig"), res as never);
    expect(res.statusCode).toBe(200);
    expect((res.body as { note?: string }).note).toBe("creator-charge-ignored");
    expect(revoke).not.toHaveBeenCalled();
    expect(mark).toHaveBeenCalledOnce();
  });

  function creatorCheckout(metadata: Record<string, string>) {
    return {
      id: "evt_cs_creator",
      type: "checkout.session.completed",
      created: 5000,
      data: {
        object: {
          id: "cs_creator",
          object: "checkout.session",
          mode: "payment",
          customer: null,
          customer_email: "biz@example.com",
          payment_status: "unpaid",
          payment_intent: "pi_creator",
          amount_total: 25_000,
          currency: "usd",
          client_reference_id: "ord_1",
          metadata,
        },
      },
    };
  }

  function wired() {
    const deps = {
      alertStaff: vi.fn(async () => {}),
      markProcessed: vi.fn(async () => {}),
      resolveTenantByCustomer: vi.fn(async () => null),
      tenantExists: vi.fn(async () => true),
      applyState: vi.fn(async () => ({ error: null })),
      setMonthlyCredits: vi.fn(async () => ({ error: null })),
      setTier: vi.fn(async () => ({ error: null })),
      applyCreditTopup: vi.fn(async () => ({ error: null })),
      clearRevocation: vi.fn(async () => ({ error: null })),
    };
    return { deps, h: makeStripeBillingWebhook({ ...baseDeps, ...deps }) };
  }

  it("checkout.session.completed for a creator hire → 200, recorded, no page, no tenant lookup, no plan or credit change", async () => {
    CURRENT_EVENT = creatorCheckout({
      zavi_creator_order_id: "ord_1",
      zavi_tenant_id: TENANT,
    });
    const { deps, h } = wired();
    const res = mockRes();
    await h(mockReq("sig"), res as never);
    expect(res.statusCode).toBe(200);
    expect((res.body as { note?: string }).note).toBe("creator-checkout-ignored");
    expect(deps.alertStaff).not.toHaveBeenCalled();
    expect(deps.markProcessed).toHaveBeenCalledOnce();
    expect(deps.markProcessed).toHaveBeenCalledWith("evt_cs_creator", "checkout.session.completed");
    expect(deps.resolveTenantByCustomer).not.toHaveBeenCalled();
    expect(deps.tenantExists).not.toHaveBeenCalled();
    expect(deps.applyState).not.toHaveBeenCalled();
    expect(deps.setMonthlyCredits).not.toHaveBeenCalled();
    expect(deps.setTier).not.toHaveBeenCalled();
    expect(deps.applyCreditTopup).not.toHaveBeenCalled();
    expect(deps.clearRevocation).not.toHaveBeenCalled();
  });

  it("the same session without the creator order id still pages and 503s as tenant_unresolved", async () => {
    CURRENT_EVENT = creatorCheckout({ zavi_tenant_id: TENANT });
    const { deps, h } = wired();
    const res = mockRes();
    await h(mockReq("sig"), res as never);
    expect(res.statusCode).toBe(503);
    expect((res.body as { error?: { code?: string } }).error?.code).toBe("tenant_unresolved");
    expect(deps.alertStaff).toHaveBeenCalledOnce();
    expect(deps.markProcessed).not.toHaveBeenCalled();
  });

  it("an empty creator order id is not treated as a creator hire", async () => {
    CURRENT_EVENT = creatorCheckout({ zavi_creator_order_id: "", zavi_tenant_id: TENANT });
    const { deps, h } = wired();
    const res = mockRes();
    await h(mockReq("sig"), res as never);
    expect(res.statusCode).toBe(503);
    expect(deps.markProcessed).not.toHaveBeenCalled();
  });
});

describe("billing webhook: refund block lift", () => {
  it("does not lift the block when apply skipped the new subscription's event as stale", async () => {
    CURRENT_EVENT = subEvent();
    const clearRevocation = vi.fn(async () => ({ error: null }));
    const h = makeStripeBillingWebhook({
      ...baseDeps,
      resolveTenantByCustomer: vi.fn(async () => TENANT),
      readRevocation: vi.fn(async () => ({ revoked: true, subscriptionId: "sub_refunded" })),
      clearRevocation,
      applyState: vi.fn(async () => ({ error: null, outcome: "skipped" })),
    });
    const res = mockRes();
    await h(mockReq("sig"), res as never);
    expect(clearRevocation).not.toHaveBeenCalled();
  });

  it("a retry after a failed lift still lifts it, though apply now answers skipped", async () => {
    CURRENT_EVENT = subEvent();
    const clearRevocation = vi.fn(async () => ({ error: null }));
    const h = makeStripeBillingWebhook({
      ...baseDeps,
      resolveTenantByCustomer: vi.fn(async () => TENANT),
      readRevocation: vi.fn(async () => ({ revoked: true, subscriptionId: "sub_1" })),
      clearRevocation,
      applyState: vi.fn(async () => ({ error: null, outcome: "skipped" })),
    });
    const res = mockRes();
    await h(mockReq("sig"), res as never);
    expect(clearRevocation).toHaveBeenCalledWith(TENANT);
  });

  it("lifts the block when a different subscription's event is applied", async () => {
    CURRENT_EVENT = subEvent();
    const clearRevocation = vi.fn(async () => ({ error: null }));
    const h = makeStripeBillingWebhook({
      ...baseDeps,
      resolveTenantByCustomer: vi.fn(async () => TENANT),
      readRevocation: vi.fn(async () => ({ revoked: true, subscriptionId: "sub_refunded" })),
      clearRevocation,
      applyState: vi.fn(async () => ({ error: null, outcome: "applied" })),
    });
    const res = mockRes();
    await h(mockReq("sig"), res as never);
    expect(clearRevocation).toHaveBeenCalledWith(TENANT);
  });
});
