
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  logEvent: vi.fn(async (_entry: { code?: string } & Record<string, unknown>) => {}),
}));
const logEvent = h.logEvent;
vi.mock("@/services/logging/logEvent", () => ({ logEvent: h.logEvent }));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({}) }));

import { makeStripeBillingWebhook } from "@/routes/webhooks/stripe-billing";

const TENANT = "44444444-4444-4444-4444-444444444444";
let CURRENT_EVENT: unknown;

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
  return res;
}
const mockReq = () =>
  ({ header: (h: string) => (h.toLowerCase() === "stripe-signature" ? "sig" : null), body: Buffer.from("{}") }) as never;

function ladderEvent(quantity: number) {
  return {
    id: `evt_${quantity}`,
    type: "customer.subscription.updated",
    created: 2000,
    data: {
      object: {
        id: "sub_1",
        customer: "cus_1",
        status: "active",
        cancel_at_period_end: false,
        current_period_end: 1893456000,
        items: { data: [{ price: { id: "price_credits_unit" }, quantity }] },
        metadata: { tenant_id: TENANT },
      },
    },
  };
}

function deps(readIncludedUsed: () => Promise<number | null>) {
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
    readIncludedUsed: vi.fn(readIncludedUsed),
    setTier: vi.fn(async () => ({ error: null })),
  };
}

const warned = () =>
  logEvent.mock.calls.some((c) => c[0]?.code === "billing.allowance.shrunk_below_used");

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_PRICE_CREDITS_UNIT = "price_credits_unit";
});

describe("allowance shrunk below used alert", () => {
  it("warns when the new allowance is below credits already used", async () => {
    CURRENT_EVENT = ladderEvent(20);
    const res = mockRes();
    await makeStripeBillingWebhook(deps(async () => 299_925))(mockReq(), res as never);
    expect(res.statusCode).toBe(200);
    expect(warned()).toBe(true);
  });

  it("does not warn when the allowance still covers what was used", async () => {
    CURRENT_EVENT = ladderEvent(400);
    const res = mockRes();
    await makeStripeBillingWebhook(deps(async () => 299_925))(mockReq(), res as never);
    expect(res.statusCode).toBe(200);
    expect(warned()).toBe(false);
  });

  it("does not warn when allowance exactly equals used (not below)", async () => {
    CURRENT_EVENT = ladderEvent(20);
    const res = mockRes();
    await makeStripeBillingWebhook(deps(async () => 20_000))(mockReq(), res as never);
    expect(warned()).toBe(false);
  });

  it("skips the alert when usage is unknown, without failing the webhook", async () => {
    CURRENT_EVENT = ladderEvent(20);
    const res = mockRes();
    await makeStripeBillingWebhook(deps(async () => null))(mockReq(), res as never);
    expect(res.statusCode).toBe(200);
    expect(warned()).toBe(false);
  });

  it("a read failure does not fail the webhook", async () => {
    CURRENT_EVENT = ladderEvent(20);
    const res = mockRes();
    await makeStripeBillingWebhook(
      deps(async () => {
        throw new Error("db down");
      }),
    )(mockReq(), res as never);
    expect(res.statusCode).toBe(200);
    expect(warned()).toBe(false);
  });
});
