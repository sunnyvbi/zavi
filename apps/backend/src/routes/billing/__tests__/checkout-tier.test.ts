
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  createSession: vi.fn(),
  createPortal: vi.fn(),
  changePlanFromCheckout: vi.fn(async (_req: unknown, res: { json: (b: unknown) => void }) => {
    res.json({ ok: true, kind: "upgrade", redirect: "https://billing.stripe.test/confirm" });
  }),
  stripeOn: true,
  subRow: { data: null as unknown, error: null as unknown },
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: async () => true }));
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
  billingStripe: () =>
    mocks.stripeOn
      ? {
          checkout: { sessions: { create: mocks.createSession } },
          billingPortal: { sessions: { create: mocks.createPortal } },
        }
      : null,
}));
vi.mock("@/services/billing/portal-config", () => ({ planChangePortalConfiguration: async () => "bpc_zavi" }));
vi.mock("../subscription", () => ({ changePlanFromCheckout: mocks.changePlanFromCheckout }));

import { billingCheckout } from "../checkout";

const TENANT = "66666666-6666-6666-6666-666666666666";

function mockRes() {
  return {
    statusCode: 200,
    body: undefined as Record<string, unknown> | undefined,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b as Record<string, unknown>; return this; },
  };
}
async function post(body: unknown) {
  const res = mockRes();
  await billingCheckout({ body } as never, res as never);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.stripeOn = true;
  mocks.requireAuth.mockResolvedValue({ tenant_id: TENANT });
  mocks.subRow = { data: null, error: null };
  mocks.createSession.mockResolvedValue({ url: "https://checkout.stripe.test/s" });
  mocks.createPortal.mockResolvedValue({ url: "https://billing.stripe.test/p" });
  process.env.STRIPE_PRICE_STARTER_MONTHLY = "price_starter";
  process.env.STRIPE_PRICE_GROWTH_MONTHLY = "price_growth";
  process.env.STRIPE_PRICE_PRO_MONTHLY = "price_pro";
});
afterEach(() => {
  delete process.env.STRIPE_PRICE_STARTER_MONTHLY;
  delete process.env.STRIPE_PRICE_GROWTH_MONTHLY;
  delete process.env.STRIPE_PRICE_PRO_MONTHLY;
});

describe("checkout: tier", () => {
  it.each([
    ["starter", "price_starter"],
    ["growth", "price_growth"],
    ["pro", "price_pro"],
  ])("tier=%s opens a subscription Checkout on %s with tenant_id + tier + term metadata", async (tier, price) => {
    const res = await post({ tier });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ url: "https://checkout.stripe.test/s" });
    const [args, opts] = mocks.createSession.mock.calls[0] as [Record<string, unknown>, { idempotencyKey: string }];
    expect(args.mode).toBe("subscription");
    expect(args.line_items).toEqual([{ price, quantity: 1 }]);
    expect(args.metadata).toEqual({ tenant_id: TENANT, tier, term: "monthly" });
    expect(args.subscription_data).toEqual({
      metadata: { tenant_id: TENANT, tier, term: "monthly" },
    });
    expect(args.client_reference_id).toBe(TENANT);
    expect(opts.idempotencyKey).toContain(TENANT);
    expect(opts.idempotencyKey).toContain(tier);
  });

  it.each([
    [{ tier: "free" }],
    [{ tier: "enterprise" }],
    [{ tier: "PRO" }],
    [{ tier: ["pro"] }],
    [{}],
    [{ usd: 50 }],
    [{ credits: 400_000 }],
    [{ plan: "team", interval: "month" }],
    [null],
  ])("rejects %j with 400 bad_tier, no Stripe call", async (body) => {
    const res = await post(body);
    expect(res.statusCode).toBe(400);
    expect((res.body?.error as { code: string }).code).toBe("bad_tier");
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.createPortal).not.toHaveBeenCalled();
  });

  it("503 when that tier's price is not configured", async () => {
    delete process.env.STRIPE_PRICE_PRO_MONTHLY;
    const res = await post({ tier: "pro" });
    expect(res.statusCode).toBe(503);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("503 when billing is not configured", async () => {
    mocks.stripeOn = false;
    const res = await post({ tier: "pro" });
    expect(res.statusCode).toBe(503);
  });

  it.each(["active", "trialing", "past_due"])(
    "already subscribed (%s) → the /change-plan rules, no picker, no new Checkout",
    async (status) => {
      mocks.subRow = {
        data: { stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", status },
        error: null,
      };
      const res = await post({ tier: "pro" });
      expect(mocks.changePlanFromCheckout).toHaveBeenCalledTimes(1);
      expect(res.body).toMatchObject({ kind: "upgrade", redirect: "https://billing.stripe.test/confirm" });
      expect(mocks.createSession).not.toHaveBeenCalled();
      expect(mocks.createPortal).not.toHaveBeenCalled();
    },
  );

  it("canceled subscription → new Checkout that reuses the Stripe customer", async () => {
    mocks.subRow = {
      data: { stripe_customer_id: "cus_1", stripe_subscription_id: "sub_old", status: "canceled" },
      error: null,
    };
    const res = await post({ tier: "growth" });
    expect(res.body).toEqual({ url: "https://checkout.stripe.test/s" });
    expect(mocks.createPortal).not.toHaveBeenCalled();
    expect((mocks.createSession.mock.calls[0][0] as { customer?: string }).customer).toBe("cus_1");
  });

  it("subscription read error → 500, no Stripe call", async () => {
    mocks.subRow = { data: null, error: { message: "db down" } };
    const res = await post({ tier: "growth" });
    expect(res.statusCode).toBe(500);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("Stripe error → 502", async () => {
    mocks.createSession.mockRejectedValue(new Error("stripe down"));
    const res = await post({ tier: "growth" });
    expect(res.statusCode).toBe(502);
  });
});
