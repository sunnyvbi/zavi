
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  createSession: vi.fn(),
  createPortal: vi.fn(),
  changePlanFromCheckout: vi.fn(async (_req: unknown, res: { json: (b: unknown) => void }) => {
    res.json({ ok: true, kind: "upgrade", redirect: "https://billing.stripe.test/confirm" });
  }),
  retrievePrice: vi.fn(),
  subRow: { data: null as unknown, error: null as unknown },
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: async () => true }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from() {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => Promise.resolve(mocks.subRow),
      };
      return chain;
    },
  }),
}));
vi.mock("@/services/billing/client", () => ({
  billingStripe: () => ({
    checkout: { sessions: { create: mocks.createSession } },
    billingPortal: { sessions: { create: mocks.createPortal } },
    prices: { retrieve: mocks.retrievePrice },
  }),
}));
vi.mock("@/services/billing/portal-config", () => ({ planChangePortalConfiguration: async () => "bpc_zavi" }));
vi.mock("../subscription", () => ({ changePlanFromCheckout: mocks.changePlanFromCheckout }));

import { billingCheckout } from "../checkout";
import {
  sixMonthUsd,
  sixMonthPerMonthUsd,
  sixMonthConfigured,
  sixMonthPriceMismatch,
  type StripePriceTerms,
} from "@/services/billing/plans";
import type { PaidTier } from "@/services/billing/tiers";

const TENANT = "66666666-6666-6666-6666-666666666666";

function mockRes() {
  return {
    statusCode: 200,
    body: undefined as Record<string, unknown> | undefined,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b as Record<string, unknown>;
      return this;
    },
  };
}
async function post(body: unknown) {
  const res = mockRes();
  await billingCheckout({ body } as never, res as never);
  return res;
}
const goodPrice = (tier: PaidTier): StripePriceTerms => ({
  active: true,
  currency: "usd",
  unit_amount: sixMonthUsd(tier) * 100,
  recurring: { interval: "month", interval_count: 6 },
});
const priceOf = () =>
  (mocks.createSession.mock.calls[0][0] as { line_items: { price: string }[] }).line_items[0].price;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ tenant_id: TENANT });
  mocks.subRow = { data: null, error: null };
  mocks.createSession.mockResolvedValue({ url: "https://checkout.stripe.test/s" });
  mocks.retrievePrice.mockImplementation(async (id: string) => goodPrice(id.replace("price_", "").replace("_6mo", "") as PaidTier));
  process.env.STRIPE_PRICE_STARTER_MONTHLY = "price_starter";
  process.env.STRIPE_PRICE_GROWTH_MONTHLY = "price_growth";
  process.env.STRIPE_PRICE_PRO_MONTHLY = "price_pro";
  process.env.STRIPE_PRICE_STARTER_6MO = "price_starter_6mo";
  process.env.STRIPE_PRICE_GROWTH_6MO = "price_growth_6mo";
  process.env.STRIPE_PRICE_PRO_6MO = "price_pro_6mo";
});
afterEach(() => {
  for (const k of [
    "STRIPE_PRICE_STARTER_MONTHLY",
    "STRIPE_PRICE_GROWTH_MONTHLY",
    "STRIPE_PRICE_PRO_MONTHLY",
    "STRIPE_PRICE_STARTER_6MO",
    "STRIPE_PRICE_GROWTH_6MO",
    "STRIPE_PRICE_PRO_6MO",
  ]) {
    delete process.env[k];
  }
});

describe("checkout: billing term", () => {
  it("no term posted still buys the monthly price", async () => {
    await post({ tier: "growth" });
    expect(priceOf()).toBe("price_growth");
  });

  it('term="6mo" buys the six-month price, not the monthly one', async () => {
    const res = await post({ tier: "growth", term: "6mo" });
    expect(res.statusCode).toBe(200);
    expect(priceOf()).toBe("price_growth_6mo");
  });

  it("the term travels in metadata so a session can be read back", async () => {
    await post({ tier: "pro", term: "6mo" });
    const args = mocks.createSession.mock.calls[0][0] as { metadata: Record<string, string> };
    expect(args.metadata).toEqual({ tenant_id: TENANT, tier: "pro", term: "6mo" });
  });

  it.each([["annual"], ["12mo"], [""], [6], [null]])(
    "refuses term=%j with 400 rather than billing monthly",
    async (term) => {
      const res = await post({ tier: "growth", term });
      expect(res.statusCode).toBe(400);
      expect((res.body?.error as { code: string }).code).toBe("bad_term");
      expect(mocks.createSession).not.toHaveBeenCalled();
    },
  );

  it("reads the six-month price back from Stripe before selling it; never the monthly one", async () => {
    await post({ tier: "growth", term: "6mo" });
    expect(mocks.retrievePrice).toHaveBeenCalledWith("price_growth_6mo");
    mocks.retrievePrice.mockClear();
    await post({ tier: "growth", term: "monthly" });
    expect(mocks.retrievePrice).not.toHaveBeenCalled();
  });

  it.each<[string, Partial<StripePriceTerms>]>([
    ["the monthly amount", { unit_amount: 12_000 }],
    ["the undiscounted amount", { unit_amount: 72_000 }],
    ["a monthly cadence", { recurring: { interval: "month", interval_count: 1 } }],
    ["a yearly cadence", { recurring: { interval: "year", interval_count: 1 } }],
    ["another currency", { currency: "eur" }],
    ["an archived price", { active: false }],
  ])("503 price_misconfigured, no session, when the Stripe price has %s", async (_label, over) => {
    mocks.retrievePrice.mockResolvedValue({ ...goodPrice("growth"), ...over });
    const res = await post({ tier: "growth", term: "6mo" });
    expect(res.statusCode).toBe(503);
    expect((res.body?.error as { code: string }).code).toBe("price_misconfigured");
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("a failed price read is a 502, never a checkout on an unchecked price", async () => {
    mocks.retrievePrice.mockRejectedValue(new Error("stripe down"));
    const res = await post({ tier: "growth", term: "6mo" });
    expect(res.statusCode).toBe(502);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("an existing subscriber goes through the /change-plan rules (which check the price), not the picker", async () => {
    mocks.subRow = {
      data: { stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", status: "active" },
      error: null,
    };
    const res = await post({ tier: "growth", term: "6mo" });
    expect(mocks.changePlanFromCheckout).toHaveBeenCalledTimes(1);
    expect(res.body?.redirect).toBe("https://billing.stripe.test/confirm");
    expect(mocks.createPortal).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("503 when the six-month price for that tier is unset — never the monthly one", async () => {
    delete process.env.STRIPE_PRICE_GROWTH_6MO;
    const res = await post({ tier: "growth", term: "6mo" });
    expect(res.statusCode).toBe(503);
    expect((res.body?.error as { code: string }).code).toBe("price_not_configured");
    expect(mocks.createSession).not.toHaveBeenCalled();
  });
});

describe("six-month pricing", () => {
  it("is six months at half price", () => {
    expect(sixMonthUsd("starter")).toBe(60);
    expect(sixMonthUsd("growth")).toBe(360);
    expect(sixMonthUsd("pro")).toBe(720);
  });

  it("per month, that is half the monthly price", () => {
    expect(sixMonthPerMonthUsd("starter")).toBe(10);
    expect(sixMonthPerMonthUsd("growth")).toBe(60);
    expect(sixMonthPerMonthUsd("pro")).toBe(120);
  });

  it("a Stripe price made to the quote matches for every tier", () => {
    for (const t of ["starter", "growth", "pro"] as const) {
      expect(sixMonthPriceMismatch(t, goodPrice(t))).toBeNull();
    }
    expect(sixMonthPriceMismatch("pro", goodPrice("starter"))).toMatch(/unit_amount/);
    expect(sixMonthPriceMismatch("growth", { ...goodPrice("growth"), currency: "USD" })).toBeNull();
    expect(sixMonthPriceMismatch("growth", { ...goodPrice("growth"), recurring: null })).toMatch(/recurs/);
  });

  it("is offered only when EVERY paid tier has a six-month price", () => {
    expect(sixMonthConfigured()).toBe(true);
    delete process.env.STRIPE_PRICE_PRO_6MO;
    expect(sixMonthConfigured()).toBe(false);
  });
});
