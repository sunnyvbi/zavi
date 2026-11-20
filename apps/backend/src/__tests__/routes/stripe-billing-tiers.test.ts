
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const db = vi.hoisted(() => ({
  calls: [] as { table: string; update?: unknown; filters: [string, string, unknown][] }[],
  error: null as null | { message: string },
}));

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from(table: string) {
      const call = { table, update: undefined as unknown, filters: [] as [string, string, unknown][] };
      db.calls.push(call);
      const chain = {
        update(v: unknown) { call.update = v; return chain; },
        eq(col: string, v: unknown) { call.filters.push(["eq", col, v]); return chain; },
        is(col: string, v: unknown) { call.filters.push(["is", col, v]); return chain; },
        lt(col: string, v: unknown) { call.filters.push(["lt", col, v]); return chain; },
        then(resolve: (r: { error: unknown }) => void) { resolve({ error: db.error }); },
      };
      return chain;
    },
  }),
}));

import { makeStripeBillingWebhook } from "@/routes/webhooks/stripe-billing";

const TENANT = "55555555-5555-5555-5555-555555555555";
let CURRENT_EVENT: unknown;

function mockRes() {
  return {
    statusCode: 200,
    body: undefined as Record<string, unknown> | undefined,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b as Record<string, unknown>; return this; },
  };
}
const req = () =>
  ({ header: (h: string) => (h.toLowerCase() === "stripe-signature" ? "sig" : null), body: Buffer.from("{}") }) as never;

function subEvent(priceId: string, over: Record<string, unknown> = {}, type = "customer.subscription.created") {
  return {
    id: "evt_t", type, created: 5000,
    data: {
      object: {
        id: "sub_t", customer: "cus_t", status: "active", cancel_at_period_end: false,
        current_period_end: 1893456000,
        items: { data: [{ price: { id: priceId, unit_amount: 12000 }, quantity: 1 }] },
        metadata: { tenant_id: TENANT, tier: "starter" },
        ...over,
      },
    },
  };
}

function deps(over: Record<string, unknown> = {}) {
  return {
    webhookSecret: () => "whsec_test",
    constructEvent: () => CURRENT_EVENT as never,
    affiliateEvent: async () => "ignored",
    eventProcessed: vi.fn(async () => false),
    markProcessed: vi.fn(async () => {}),
    resolveTenantByCustomer: vi.fn(async () => TENANT),
    tenantExists: vi.fn(async () => true),
    readRevocation: vi.fn(async () => ({ revoked: false, subscriptionId: null })),
    clearRevocation: vi.fn(async () => ({ error: null })),
    applyState: vi.fn(async () => ({ error: null })),
    setMonthlyCredits: vi.fn(async () => ({ error: null })),
    resolvePaymentIntentForCharge: vi.fn(async () => null),
    pricingConfig: vi.fn(async () => ({ creditsPerUsd: 400, tiers: {} })),
    readIncludedUsed: vi.fn(async () => null),
    setTier: vi.fn(async () => ({ error: null })),
    clearTierForSubscription: vi.fn(async () => ({ error: null })),
    tierCredits: vi.fn(async () => ({ starter: 8_000, growth: 48_000, pro: 96_000 })),
    requestPreviewRerun: vi.fn(async () => undefined),
    ...over,
  };
}

const ENV_KEYS = [
  "STRIPE_PRICE_STARTER_MONTHLY", "STRIPE_PRICE_GROWTH_MONTHLY", "STRIPE_PRICE_PRO_MONTHLY",
  "STRIPE_PRICE_STARTER_6MO", "STRIPE_PRICE_GROWTH_6MO", "STRIPE_PRICE_PRO_6MO",
  "STRIPE_PRICE_CREDITS_UNIT", "STRIPE_PRICE_TEAM_MONTHLY",
];
beforeEach(() => {
  db.calls = [];
  db.error = null;
  process.env.STRIPE_PRICE_STARTER_MONTHLY = "price_starter";
  process.env.STRIPE_PRICE_GROWTH_MONTHLY = "price_growth";
  process.env.STRIPE_PRICE_PRO_MONTHLY = "price_pro";
  process.env.STRIPE_PRICE_STARTER_6MO = "price_starter_6mo";
  process.env.STRIPE_PRICE_GROWTH_6MO = "price_growth_6mo";
  process.env.STRIPE_PRICE_PRO_6MO = "price_pro_6mo";
  process.env.STRIPE_PRICE_CREDITS_UNIT = "price_credits_unit";
});
afterEach(() => { for (const k of ENV_KEYS) delete process.env[k]; });

describe("webhook: tier subscriptions", () => {
  it.each([
    ["price_starter", "starter"],
    ["price_growth", "growth"],
    ["price_pro", "pro"],
  ])("created on %s → apply plan=team, tier=%s, NO credit number written", async (price, tier) => {
    CURRENT_EVENT = subEvent(price);
    const d = deps();
    const h = makeStripeBillingWebhook(d);
    const res = mockRes();
    await h(req(), res as never);
    expect(res.statusCode).toBe(200);
    expect(d.applyState).toHaveBeenCalledWith(expect.objectContaining({ plan: "team", status: "active", tenant_id: TENANT }));
    expect(d.setTier).toHaveBeenCalledWith(TENANT, tier, 5000);
    expect(d.setMonthlyCredits).toHaveBeenCalledWith(TENANT, null, null, 5000);
    expect(d.pricingConfig).not.toHaveBeenCalled();
    expect(d.markProcessed).toHaveBeenCalledOnce();
    expect(res.body?.tier).toBe(tier);
  });

  it.each([
    ["price_starter_6mo", "starter"],
    ["price_growth_6mo", "growth"],
    ["price_pro_6mo", "pro"],
  ])("six-month price %s grants tier=%s", async (price, tier) => {
    CURRENT_EVENT = subEvent(price);
    const d = deps();
    const res = mockRes();
    await makeStripeBillingWebhook(d)(req(), res as never);
    expect(res.statusCode).toBe(200);
    expect(d.setTier).toHaveBeenCalledWith(TENANT, tier, 5000);
    expect(d.setMonthlyCredits).toHaveBeenCalledWith(TENANT, null, null, 5000);
  });

  it("metadata tier is ignored — the BILLED price decides (upgrade via Portal)", async () => {
    CURRENT_EVENT = subEvent("price_pro", { metadata: { tenant_id: TENANT, tier: "starter" } }, "customer.subscription.updated");
    const d = deps();
    await makeStripeBillingWebhook(d)(req(), mockRes() as never);
    expect(d.setTier).toHaveBeenCalledWith(TENANT, "pro", 5000);
  });

  it("trialing grants the tier; past_due / incomplete leave it UNCHANGED", async () => {
    CURRENT_EVENT = subEvent("price_growth", { status: "trialing" });
    let d = deps();
    await makeStripeBillingWebhook(d)(req(), mockRes() as never);
    expect(d.setTier).toHaveBeenCalledWith(TENANT, "growth", 5000);

    for (const status of ["past_due", "incomplete", "unpaid"]) {
      CURRENT_EVENT = subEvent("price_growth", { status }, "customer.subscription.updated");
      d = deps();
      const res = mockRes();
      await makeStripeBillingWebhook(d)(req(), res as never);
      expect(res.statusCode).toBe(200);
      expect(d.applyState).toHaveBeenCalledOnce();
      expect(d.setTier).toHaveBeenCalledWith(TENANT, "keep", 5000);
    }
  });

  it("a tier subscription writes the tier BEFORE the credit call that refreshes the wallet", async () => {
    CURRENT_EVENT = subEvent("price_starter");
    const order: string[] = [];
    const d = deps();
    d.setTier = vi.fn(async () => { order.push("tier"); return { error: null }; });
    d.setMonthlyCredits = vi.fn(async () => { order.push("credits"); return { error: null }; });
    const res = mockRes();
    await makeStripeBillingWebhook(d)(req(), res as never);
    expect(res.statusCode).toBe(200);
    expect(order).toEqual(["tier", "credits"]);
  });

  it("canceled tier subscription applies plan free (never the legacy Team allowance)", async () => {
    CURRENT_EVENT = subEvent("price_pro", { status: "canceled" }, "customer.subscription.deleted");
    const d = deps();
    await makeStripeBillingWebhook(d)(req(), mockRes() as never);
    expect(d.applyState).toHaveBeenCalledWith(expect.objectContaining({ plan: "free", status: "canceled" }));
  });

  it("deleted → status canceled, tier cleared (null)", async () => {
    CURRENT_EVENT = subEvent("price_pro", { status: "canceled" }, "customer.subscription.deleted");
    const d = deps();
    const res = mockRes();
    await makeStripeBillingWebhook(d)(req(), res as never);
    expect(res.statusCode).toBe(200);
    expect(d.applyState).toHaveBeenCalledWith(expect.objectContaining({ status: "canceled" }));
    expect(d.setTier).toHaveBeenCalledWith(TENANT, null, 5000);
  });

  it("legacy credits-unit (dogfood) subscription still grants its ladder volume and has no tier", async () => {
    CURRENT_EVENT = subEvent("price_credits_unit", {
      items: { data: [{ price: { id: "price_credits_unit", unit_amount: 250 }, quantity: 20 }] },
    });
    const d = deps();
    const res = mockRes();
    await makeStripeBillingWebhook(d)(req(), res as never);
    expect(res.statusCode).toBe(200);
    expect(d.setMonthlyCredits).toHaveBeenCalledWith(TENANT, 20_000, 50, 5000);
    expect(d.setTier).toHaveBeenCalledWith(TENANT, null, 5000);
  });

  it("unknown price on an active sub → 503 (Stripe retries), no apply, no tier, no grant, not recorded", async () => {
    CURRENT_EVENT = subEvent("price_mystery");
    const d = deps();
    const res = mockRes();
    await makeStripeBillingWebhook(d)(req(), res as never);
    expect(res.statusCode).toBe(503);
    expect(d.markProcessed).not.toHaveBeenCalled();
    expect(d.applyState).not.toHaveBeenCalled();
    expect(d.setTier).not.toHaveBeenCalled();
    expect(d.setMonthlyCredits).not.toHaveBeenCalled();
  });

  it("unknown price on a DELETED sub still removes access (plan free, tier + override cleared)", async () => {
    CURRENT_EVENT = subEvent("price_mystery", { status: "canceled" }, "customer.subscription.deleted");
    const d = deps();
    const res = mockRes();
    await makeStripeBillingWebhook(d)(req(), res as never);
    expect(res.statusCode).toBe(200);
    expect(d.applyState).toHaveBeenCalledWith(expect.objectContaining({ plan: "free", status: "canceled" }));
    expect(d.setTier).toHaveBeenCalledWith(TENANT, null, 5000);
    expect(d.setMonthlyCredits).toHaveBeenCalledWith(TENANT, null, null, 5000);
  });

  it("a failed tier write → 500 and the event is NOT recorded (Stripe retries)", async () => {
    CURRENT_EVENT = subEvent("price_pro");
    const d = deps({ setTier: vi.fn(async () => ({ error: { message: "boom" } })) });
    const res = mockRes();
    await makeStripeBillingWebhook(d)(req(), res as never);
    expect(res.statusCode).toBe(500);
    expect(d.markProcessed).not.toHaveBeenCalled();
  });

  it("a failed apply never writes the tier", async () => {
    CURRENT_EVENT = subEvent("price_pro");
    const d = deps({ applyState: vi.fn(async () => ({ error: { message: "db" } })) });
    const res = mockRes();
    await makeStripeBillingWebhook(d)(req(), res as never);
    expect(res.statusCode).toBe(500);
    expect(d.setTier).not.toHaveBeenCalled();
  });
});

describe("webhook: refund of a tier subscription", () => {
  const refund = () => ({
    id: "evt_rf", type: "charge.refunded", created: 6000,
    data: { object: { id: "ch_t", customer: "cus_t", refunded: true, invoice: "in_t" } },
  });

  it("applied revoke also clears the tier for that subscription", async () => {
    CURRENT_EVENT = refund();
    const d = deps({
      resolveSubscriptionForCharge: vi.fn(async () => "sub_t"),
      revokeCredits: vi.fn(async () => ({ error: null, applied: true })),
    });
    const res = mockRes();
    await makeStripeBillingWebhook(d)(req(), res as never);
    expect(res.statusCode).toBe(200);
    expect(d.clearTierForSubscription).toHaveBeenCalledWith(TENANT, "sub_t");
    expect(d.markProcessed).toHaveBeenCalledOnce();
  });

  it("revoke that did not apply (other subscription) leaves the tier alone", async () => {
    CURRENT_EVENT = refund();
    const d = deps({
      resolveSubscriptionForCharge: vi.fn(async () => "sub_old"),
      revokeCredits: vi.fn(async () => ({ error: null, applied: false })),
    });
    await makeStripeBillingWebhook(d)(req(), mockRes() as never);
    expect(d.clearTierForSubscription).not.toHaveBeenCalled();
  });

  it("a failed tier clear → 500, not recorded", async () => {
    CURRENT_EVENT = refund();
    const d = deps({
      resolveSubscriptionForCharge: vi.fn(async () => "sub_t"),
      revokeCredits: vi.fn(async () => ({ error: null, applied: true })),
      clearTierForSubscription: vi.fn(async () => ({ error: { message: "x" } })),
    });
    const res = mockRes();
    await makeStripeBillingWebhook(d)(req(), res as never);
    expect(res.statusCode).toBe(500);
    expect(d.markProcessed).not.toHaveBeenCalled();
  });
});

describe("default tier writers (guards)", () => {
  it("positive tier write is watermark-guarded, skips grandfathered, and refuses a refund-blocked row", async () => {
    CURRENT_EVENT = subEvent("price_growth");
    const { setTier: _omit, ...rest } = deps();
    void _omit;
    const res = mockRes();
    await makeStripeBillingWebhook(rest)(req(), res as never);
    expect(res.statusCode).toBe(200);
    const call = db.calls.find((c) => c.table === "tenant_subscriptions");
    expect(call?.update).toMatchObject({ tier: "growth", tier_event_created: 5000 });
    expect(call?.filters).toEqual(expect.arrayContaining([
      ["eq", "tenant_id", TENANT],
      ["eq", "stripe_event_created", 5000],
      ["lt", "tier_event_created", 5000],
      ["eq", "grandfathered", false],
      ["is", "credits_revoked_at", null],
    ]));
  });

  it("a withheld (past_due) event advances only the tier watermark", async () => {
    CURRENT_EVENT = subEvent("price_growth", { status: "past_due" }, "customer.subscription.updated");
    const { setTier: _omit, ...rest } = deps();
    void _omit;
    await makeStripeBillingWebhook(rest)(req(), mockRes() as never);
    const call = db.calls.find((c) => c.table === "tenant_subscriptions");
    expect(call?.update).toMatchObject({ tier_event_created: 5000 });
    expect(call?.update).not.toHaveProperty("tier");
    expect(call?.filters).toContainEqual(["lt", "tier_event_created", 5000]);
  });

  it("clearing the tier (cancel) is watermark-guarded but NOT blocked by a refund block", async () => {
    CURRENT_EVENT = subEvent("price_growth", { status: "canceled" }, "customer.subscription.deleted");
    const { setTier: _omit, ...rest } = deps();
    void _omit;
    await makeStripeBillingWebhook(rest)(req(), mockRes() as never);
    const call = db.calls.find((c) => c.table === "tenant_subscriptions");
    expect(call?.update).toMatchObject({ tier: null });
    expect(call?.filters).toContainEqual(["eq", "stripe_event_created", 5000]);
    expect(call?.filters.some(([, col]) => col === "credits_revoked_at")).toBe(false);
  });

  it("a DB error from the default writer surfaces as 500", async () => {
    CURRENT_EVENT = subEvent("price_growth");
    db.error = { message: "column tier does not exist" };
    const { setTier: _omit, ...rest } = deps();
    void _omit;
    const res = mockRes();
    await makeStripeBillingWebhook(rest)(req(), res as never);
    expect(res.statusCode).toBe(500);
  });
});

describe("webhook: a paid tier asks for the channels previewed on Free to run for real", () => {
  it("an active tier queues the re-run for that tenant, after every billing write", async () => {
    CURRENT_EVENT = subEvent("price_starter");
    const order: string[] = [];
    const d = deps({
      setMonthlyCredits: vi.fn(async () => {
        order.push("credits");
        return { error: null };
      }),
      requestPreviewRerun: vi.fn(async () => {
        order.push("rerun");
      }),
      markProcessed: vi.fn(async () => {
        order.push("processed");
      }),
    });
    const res = mockRes();
    await makeStripeBillingWebhook(d)(req(), res as never);
    expect(res.statusCode).toBe(200);
    expect(d.requestPreviewRerun).toHaveBeenCalledWith(TENANT);
    expect(order).toEqual(["credits", "rerun", "processed"]);
  });

  it("a cancellation does not", async () => {
    CURRENT_EVENT = subEvent("price_starter", { status: "canceled" }, "customer.subscription.updated");
    const d = deps();
    await makeStripeBillingWebhook(d)(req(), mockRes() as never);
    expect(d.requestPreviewRerun).not.toHaveBeenCalled();
  });

  it("a failed send answers 500 AFTER the billing writes landed, and is not marked processed", async () => {
    CURRENT_EVENT = subEvent("price_growth");
    const d = deps({ requestPreviewRerun: vi.fn(async () => { throw new Error("inngest down"); }) });
    const res = mockRes();
    await makeStripeBillingWebhook(d)(req(), res as never);
    expect(res.statusCode).toBe(500);
    expect(d.setTier).toHaveBeenCalled();
    expect(d.setMonthlyCredits).toHaveBeenCalled();
    expect(d.markProcessed).not.toHaveBeenCalled();
  });
});
