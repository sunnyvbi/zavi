
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  requireTenantRole: vi.fn(),
  createSession: vi.fn(),
  tierCredits: vi.fn(),
  subRow: { data: null as unknown, error: null as unknown },
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: mocks.requireTenantRole }));
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
  billingStripe: () => ({ checkout: { sessions: { create: mocks.createSession } } }),
}));
vi.mock("@/services/billing/credit-rate", () => ({ getTierCreditsStrict: mocks.tierCredits }));

import { billingTopup } from "../topup";

const TENANT = "77777777-7777-7777-7777-777777777777";

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
  await billingTopup({ body } as never, res as never);
  return res;
}
const paidSub = (tier = "starter", status = "active") => ({
  data: { stripe_customer_id: "cus_1", tier, status },
  error: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ tenant_id: TENANT });
  mocks.requireTenantRole.mockResolvedValue(true);
  mocks.subRow = paidSub();
  mocks.createSession.mockResolvedValue({ url: "https://checkout.stripe.test/t" });
  mocks.tierCredits.mockResolvedValue({ starter: 8_000, growth: 48_000, pro: 96_000 });
});

describe("topup: packs", () => {
  it.each([
    [20, 2000, 8_000],
    [120, 12000, 48_000],
    [240, 24000, 96_000],
  ])("$%i pack charges %i cents and quotes %i credits from config", async (usd, cents, credits) => {
    const res = await post({ usd });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ url: "https://checkout.stripe.test/t" });
    const args = mocks.createSession.mock.calls[0][0] as {
      mode: string;
      line_items: { price_data: { unit_amount: number; currency: string } }[];
      metadata: Record<string, string>;
      payment_intent_data: { metadata: Record<string, string> };
    };
    expect(args.mode).toBe("payment");
    expect(args.line_items[0].price_data.unit_amount).toBe(cents);
    expect(args.line_items[0].price_data.currency).toBe("usd");
    expect(args.metadata).toMatchObject({ kind: "credit_topup", tenant_id: TENANT, credits: String(credits) });
    expect(args.payment_intent_data.metadata).toMatchObject({ kind: "credit_topup", tenant_id: TENANT });
  });

  it("a pack's credits follow LIVE config", async () => {
    mocks.tierCredits.mockResolvedValue({ starter: 1, growth: 60_000, pro: 2 });
    await post({ usd: 120 });
    const meta = (mocks.createSession.mock.calls[0][0] as { metadata: Record<string, string> }).metadata;
    expect(meta.credits).toBe("60000");
  });

  it.each([[{ usd: 50 }], [{ usd: 1000 }], [{ usd: "20" }], [{ usd: 20.5 }], [{ credits: 8000 }], [{}], [null]])(
    "rejects %j with 400 bad_amount, no Stripe call",
    async (body) => {
      const res = await post(body);
      expect(res.statusCode).toBe(400);
      expect((res.body?.error as { code: string }).code).toBe("bad_amount");
      expect(mocks.createSession).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["no subscription row", { data: null, error: null }],
    ["free tier", paidSub("free")],
    ["null tier", paidSub(null as unknown as string)],
    ["paid tier but canceled", paidSub("pro", "canceled")],
    ["paid tier but incomplete", paidSub("pro", "incomplete")],
    ["garbage tier", paidSub("enterprise")],
  ])("sells a pack for %s (no paid plan needed)", async (_label, row) => {
    mocks.subRow = row;
    const res = await post({ usd: 20 });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ url: "https://checkout.stripe.test/t" });
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
  });

  it("no subscription row: checkout opens without a Stripe customer", async () => {
    mocks.subRow = { data: null, error: null };
    await post({ usd: 20 });
    const args = mocks.createSession.mock.calls[0][0] as { customer?: string; client_reference_id: string };
    expect(args.customer).toBeUndefined();
    expect(args.client_reference_id).toBe(TENANT);
  });

  it.each(["starter", "growth", "pro"])("any paid tier (%s) may buy any pack", async (tier) => {
    mocks.subRow = paidSub(tier);
    const res = await post({ usd: 240 });
    expect(res.statusCode).toBe(200);
  });

  it("a non-owner/admin member gets no Stripe session", async () => {
    mocks.requireTenantRole.mockResolvedValue(false);
    await post({ usd: 20 });
    expect(mocks.requireTenantRole).toHaveBeenCalledWith({ tenant_id: TENANT }, ["owner", "admin"], expect.anything());
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("config read failure → 503, no Stripe call (fail closed)", async () => {
    mocks.tierCredits.mockRejectedValue(new Error("config down"));
    const res = await post({ usd: 20 });
    expect(res.statusCode).toBe(503);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("subscription read error → 500", async () => {
    mocks.subRow = { data: null, error: { message: "db" } };
    const res = await post({ usd: 20 });
    expect(res.statusCode).toBe(500);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });
});

describe("topup: Shopify-billed workspace", () => {
  it("refuses a live Shopify plan before opening any Stripe session", async () => {
    mocks.subRow = { data: { stripe_customer_id: null, source: "shopify", status: "active" }, error: null };
    const res = await post({ usd: 20 });
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ error: { code: "managed_in_store" } });
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("an ended Shopify plan can buy a pack", async () => {
    mocks.subRow = { data: { stripe_customer_id: null, source: "shopify", status: "canceled" }, error: null };
    const res = await post({ usd: 20 });
    expect(res.statusCode).toBe(200);
  });
});
