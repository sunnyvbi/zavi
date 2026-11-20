
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({ api: null as ReturnType<typeof stripeApi> | null }));

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({}) }));
vi.mock("@/services/billing/client", () => ({
  requireBillingStripe: () => {
    if (!mocks.api) throw new Error("billing Stripe client not configured");
    return mocks.api;
  },
  billingWebhookStripe: () => ({ webhooks: {} }),
}));

import { makeStripeBillingWebhook } from "@/routes/webhooks/stripe-billing";

const TENANT = "11111111-1111-1111-1111-111111111111";
let CURRENT_EVENT: unknown;

function mockRes() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
}
const req = () =>
  ({ header: (h: string) => (h.toLowerCase() === "stripe-signature" ? "sig" : null), body: Buffer.from("{}") }) as never;

function stripeApi(
  charge: Record<string, unknown>,
  pi: Record<string, unknown>,
  invoice: Record<string, unknown> = {},
) {
  return {
    charges: { retrieve: vi.fn(async () => charge) },
    paymentIntents: { retrieve: vi.fn(async () => pi) },
    invoices: { retrieve: vi.fn(async () => invoice) },
  };
}

function deps() {
  return {
    webhookSecret: () => "whsec_test",
    constructEvent: () => CURRENT_EVENT as never,
    affiliateEvent: async () => "ignored",
    eventProcessed: vi.fn(async () => false),
    markProcessed: vi.fn(async () => {}),
    resolveTenantByCustomer: vi.fn(async (c: string) => (c === "cus_1" ? TENANT : null)),
    tenantExists: vi.fn(async () => true),
    readRevocation: vi.fn(async () => ({ revoked: false, subscriptionId: null })),
    clearRevocation: vi.fn(async () => ({ error: null })),
    revokeCreditTopup: vi.fn(async () => ({ error: null, outcome: "revoked" })),
    revokeCredits: vi.fn(async () => ({ error: null, applied: true })),
    clearTierForSubscription: vi.fn(async () => ({ error: null })),
  };
}

beforeEach(() => { mocks.api = null; });

describe("billing webhook: refund/dispute lookups use the real-key client", () => {
  it("top-up refund → reads charge + payment intent, claws the pack back", async () => {
    CURRENT_EVENT = {
      id: "evt_topup_refund", type: "charge.refunded", created: 4000,
      data: { object: { id: "ch_t", refunded: true } },
    };
    mocks.api = stripeApi(
      { id: "ch_t", payment_intent: "pi_t" },
      { id: "pi_t", metadata: { kind: "credit_topup", tenant_id: TENANT } },
    );
    const d = deps();
    const res = mockRes();
    await makeStripeBillingWebhook(d)(req(), res as never);

    expect(res.statusCode).toBe(200);
    expect((res.body as { note?: string }).note).toBe("topup-revoked");
    expect(mocks.api.charges.retrieve).toHaveBeenCalledWith("ch_t");
    expect(mocks.api.paymentIntents.retrieve).toHaveBeenCalledWith("pi_t");
    expect(d.revokeCreditTopup).toHaveBeenCalledWith("pi_t", "evt_topup_refund", TENANT);
    expect(d.markProcessed).toHaveBeenCalledOnce();
  });

  it("subscription refund → reads charge → invoice → subscription, revokes that plan", async () => {
    CURRENT_EVENT = {
      id: "evt_sub_refund", type: "charge.refunded", created: 4100,
      data: { object: { id: "ch_s", customer: "cus_1", refunded: true } },
    };
    mocks.api = stripeApi(
      { id: "ch_s", payment_intent: "pi_s", invoice: "in_s" },
      { id: "pi_s", metadata: {} },
      { id: "in_s", subscription: "sub_1" },
    );
    const d = deps();
    const res = mockRes();
    await makeStripeBillingWebhook(d)(req(), res as never);

    expect(res.statusCode).toBe(200);
    expect((res.body as { note?: string }).note).toBe("credits-revoked");
    expect(mocks.api.invoices.retrieve).toHaveBeenCalledWith("in_s");
    expect(d.revokeCredits).toHaveBeenCalledWith(TENANT, 4100, "sub_1");
    expect(d.clearTierForSubscription).toHaveBeenCalledWith(TENANT, "sub_1");
  });

  it("dispute (no customer on the event) → reads the customer off the charge, revokes", async () => {
    CURRENT_EVENT = {
      id: "evt_dispute", type: "charge.dispute.created", created: 4200,
      data: { object: { id: "dp_1", charge: "ch_d" } },
    };
    mocks.api = stripeApi(
      { id: "ch_d", customer: "cus_1", payment_intent: "pi_d", invoice: "in_d" },
      { id: "pi_d", metadata: {} },
      { id: "in_d", subscription: "sub_1" },
    );
    const d = deps();
    const res = mockRes();
    await makeStripeBillingWebhook(d)(req(), res as never);

    expect(res.statusCode).toBe(200);
    expect(d.resolveTenantByCustomer).toHaveBeenCalledWith("cus_1");
    expect(d.revokeCredits).toHaveBeenCalledWith(TENANT, 4200, "sub_1");
  });

  it("billing key not configured → 500 so Stripe retries; nothing revoked or recorded", async () => {
    CURRENT_EVENT = {
      id: "evt_no_key", type: "charge.refunded", created: 4300,
      data: { object: { id: "ch_t", refunded: true } },
    };
    const d = deps();
    const res = mockRes();
    await makeStripeBillingWebhook(d)(req(), res as never);

    expect(res.statusCode).toBe(500);
    expect(d.revokeCreditTopup).not.toHaveBeenCalled();
    expect(d.revokeCredits).not.toHaveBeenCalled();
    expect(d.markProcessed).not.toHaveBeenCalled();
  });
});

describe("requireBillingStripe", () => {
  const ENV = [
    "STRIPE_PLATFORM_SECRET_KEY",
    "STRIPE_PRICE_STARTER_MONTHLY", "STRIPE_PRICE_GROWTH_MONTHLY", "STRIPE_PRICE_PRO_MONTHLY",
  ];
  afterEach(() => { for (const k of ENV) delete process.env[k]; });

  it("throws when billing is not configured", async () => {
    const real = await vi.importActual<typeof import("@/services/billing/client")>("@/services/billing/client");
    expect(() => real.requireBillingStripe()).toThrow(/not configured/);
  });

  it("is the same platform-key client the checkout routes use", async () => {
    process.env.STRIPE_PLATFORM_SECRET_KEY = "sk_test_platform";
    process.env.STRIPE_PRICE_STARTER_MONTHLY = "price_s";
    process.env.STRIPE_PRICE_GROWTH_MONTHLY = "price_g";
    process.env.STRIPE_PRICE_PRO_MONTHLY = "price_p";
    const real = await vi.importActual<typeof import("@/services/billing/client")>("@/services/billing/client");
    const client = real.requireBillingStripe();
    expect(client).toBe(real.billingStripe());
    expect(typeof client.charges.retrieve).toBe("function");
  });
});
