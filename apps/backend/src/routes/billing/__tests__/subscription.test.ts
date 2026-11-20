
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  requireTenantRole: vi.fn(),
  subRow: { data: null as unknown, error: null as unknown },
  subscriptions: { retrieve: vi.fn(), update: vi.fn() },
  schedules: { create: vi.fn(), retrieve: vi.fn(), update: vi.fn(), release: vi.fn() },
  portal: vi.fn(),
  prices: vi.fn(),
  portalConfig: vi.fn(async (..._a: unknown[]) => "bpc_zavi"),
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: mocks.requireTenantRole }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
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
    subscriptions: mocks.subscriptions,
    subscriptionSchedules: mocks.schedules,
    billingPortal: { sessions: { create: mocks.portal } },
    prices: { retrieve: mocks.prices },
  }),
}));
vi.mock("@/services/billing/portal-config", () => ({ planChangePortalConfiguration: mocks.portalConfig }));

import { billingCancel, billingChangePlan, billingResume, changePlanFromCheckout, classifyPlanChange } from "../subscription";

const TENANT = "77777777-7777-7777-7777-777777777777";
const PERIOD_START = 1_790_000_000;
const PERIOD_END = PERIOD_START + 30 * 86_400;

function mockRes() {
  return {
    statusCode: 200,
    body: undefined as Record<string, unknown> | undefined,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b as Record<string, unknown>; return this; },
  };
}
async function call(fn: typeof billingChangePlan, body: unknown = {}) {
  const res = mockRes();
  await fn({ body } as never, res as never);
  return res;
}

function sub(price: string, extra: Record<string, unknown> = {}) {
  return {
    id: "sub_1",
    status: "active",
    current_period_end: PERIOD_END,
    cancel_at_period_end: false,
    schedule: null,
    items: { data: [{ id: "si_1", quantity: 1, price: { id: price } }] },
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_PRICE_STARTER_MONTHLY = "price_starter";
  process.env.STRIPE_PRICE_GROWTH_MONTHLY = "price_growth";
  process.env.STRIPE_PRICE_PRO_MONTHLY = "price_pro";
  mocks.requireAuth.mockResolvedValue({ tenant_id: TENANT, user_id: "u1" });
  mocks.requireTenantRole.mockResolvedValue(true);
  mocks.subRow = {
    data: { stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", status: "active" },
    error: null,
  };
  mocks.portal.mockResolvedValue({ url: "https://billing.stripe.test/confirm" });
  mocks.schedules.create.mockResolvedValue({ id: "sched_1" });
  mocks.schedules.retrieve.mockResolvedValue({
    id: "sched_1",
    phases: [{ start_date: PERIOD_START, end_date: PERIOD_END, discounts: [], items: [{ price: "price_growth" }] }],
  });
});
afterEach(() => {
  delete process.env.STRIPE_PRICE_STARTER_MONTHLY;
  delete process.env.STRIPE_PRICE_GROWTH_MONTHLY;
  delete process.env.STRIPE_PRICE_PRO_MONTHLY;
});

describe("classifyPlanChange", () => {
  it("ranks tiers, then the term", () => {
    expect(classifyPlanChange({ tier: "starter", term: "monthly" }, { tier: "pro", term: "monthly" })).toBe("upgrade");
    expect(classifyPlanChange({ tier: "pro", term: "monthly" }, { tier: "growth", term: "6mo" })).toBe("downgrade");
    expect(classifyPlanChange({ tier: "growth", term: "monthly" }, { tier: "growth", term: "6mo" })).toBe("upgrade");
    expect(classifyPlanChange({ tier: "growth", term: "6mo" }, { tier: "growth", term: "monthly" })).toBe("downgrade");
    expect(classifyPlanChange({ tier: "growth", term: "monthly" }, { tier: "growth", term: "monthly" })).toBe("same");
  });
});

describe("POST /api/billing/change-plan", () => {
  it("upgrade → Stripe confirm page for the new price, redirecting back into Zavi", async () => {
    mocks.subscriptions.retrieve.mockResolvedValue(sub("price_starter"));
    const res = await call(billingChangePlan, { tier: "pro" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ kind: "upgrade", redirect: "https://billing.stripe.test/confirm" });
    const args = mocks.portal.mock.calls[0][0];
    expect(args.flow_data.type).toBe("subscription_update_confirm");
    expect(args.configuration).toBe("bpc_zavi");
    expect(mocks.portalConfig.mock.calls[0][2]).toBe("confirm");
    expect(args.flow_data.subscription_update_confirm.items).toEqual([{ id: "si_1", price: "price_pro" }]);
    expect(args.flow_data.after_completion.redirect.return_url).toContain("/workspace?tab=settings");
    expect(mocks.schedules.update).not.toHaveBeenCalled();
  });

  it("legacy (unmapped) current price → picker configuration, not confirm", async () => {
    mocks.subscriptions.retrieve.mockResolvedValue(sub("price_legacy_1000"));
    const res = await call(billingChangePlan, { tier: "starter" });
    expect(res.statusCode).toBe(200);
    expect(mocks.portalConfig.mock.calls[0][2]).toBe("picker");
  });

  it.each([
    [{ schedule: "sched_9" }],
    [{ cancel_at_period_end: true }],
  ])("upgrade with a pending change %j → 409, nothing touched", async (extra) => {
    mocks.subscriptions.retrieve.mockResolvedValue(sub("price_starter", extra));
    mocks.schedules.retrieve.mockResolvedValue({
      phases: [{ start_date: 0, end_date: 1 }, { start_date: PERIOD_END, items: [{ price: "price_starter" }] }],
    });
    const res = await call(billingChangePlan, { tier: "growth" });
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ error: { code: "pending_change" } });
    expect(mocks.schedules.release).not.toHaveBeenCalled();
    expect(mocks.subscriptions.update).not.toHaveBeenCalled();
    expect(mocks.portal).not.toHaveBeenCalled();
  });

  it("upgrade with a downgrade already in effect (no next phase) → detaches it and opens confirm", async () => {
    mocks.subscriptions.retrieve.mockResolvedValue(sub("price_starter", { schedule: "sched_9" }));
    const res = await call(billingChangePlan, { tier: "growth" });
    expect(res.statusCode).toBe(200);
    expect(mocks.schedules.release).toHaveBeenCalledWith("sched_9");
    expect(mocks.portal).toHaveBeenCalled();
  });

  it("downgrade passes one key per discount and carries only an applied discount forward", async () => {
    mocks.subscriptions.retrieve.mockResolvedValue(sub("price_growth"));
    mocks.schedules.retrieve.mockResolvedValue({
      id: "sched_1",
      phases: [{
        start_date: PERIOD_START, end_date: PERIOD_END, items: [{ price: "price_growth" }],
        discounts: [
          { coupon: "co_1", discount: "di_1", promotion_code: "promo_1" },
          { coupon: null, discount: null, promotion_code: "promo_2" },
        ],
      }],
    });
    await call(billingChangePlan, { tier: "starter" });
    const [, params] = mocks.schedules.update.mock.calls[0];
    expect(params.phases[0].discounts).toEqual([{ discount: "di_1" }, { promotion_code: "promo_2" }]);
    expect(params.phases[1].discounts).toEqual([{ discount: "di_1" }]);
  });

  it("downgrade → schedules the lower price at period end, current period untouched", async () => {
    mocks.subscriptions.retrieve.mockResolvedValue(sub("price_growth"));
    const res = await call(billingChangePlan, { tier: "starter" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ kind: "downgrade" });
    expect(mocks.portal).not.toHaveBeenCalled();
    expect(mocks.schedules.create).toHaveBeenCalledWith({ from_subscription: "sub_1" });
    const [id, params] = mocks.schedules.update.mock.calls[0];
    expect(id).toBe("sched_1");
    expect(params.end_behavior).toBe("release");
    expect(params.phases[0]).toMatchObject({
      items: [{ price: "price_growth", quantity: 1 }],
      start_date: PERIOD_START,
      end_date: PERIOD_END,
      proration_behavior: "none",
    });
    expect(params.phases[1]).toMatchObject({ items: [{ price: "price_starter", quantity: 1 }], iterations: 1 });
  });

  it("from checkout: a downgrade is scheduled for period end and redirects to Billing", async () => {
    mocks.subscriptions.retrieve.mockResolvedValue(sub("price_growth"));
    const res = await call(changePlanFromCheckout, { tier: "starter" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ kind: "downgrade" });
    expect(res.body?.redirect).toContain("/workspace?tab=settings#billing");
    expect(mocks.portal).not.toHaveBeenCalled();
    expect(mocks.schedules.update).toHaveBeenCalled();
  });

  it("from checkout: an upgrade opens the confirm page under the confirm configuration", async () => {
    mocks.subscriptions.retrieve.mockResolvedValue(sub("price_starter"));
    const res = await call(changePlanFromCheckout, { tier: "pro" });
    expect(res.body).toMatchObject({ kind: "upgrade", redirect: "https://billing.stripe.test/confirm" });
    expect(mocks.portal.mock.calls[0][0].flow_data.type).toBe("subscription_update_confirm");
    expect(mocks.portalConfig.mock.calls[0][2]).toBe("confirm");
  });

  it("change-plan's own downgrade reply carries no redirect", async () => {
    mocks.subscriptions.retrieve.mockResolvedValue(sub("price_growth"));
    const res = await call(billingChangePlan, { tier: "starter" });
    expect(res.body?.redirect).toBeUndefined();
  });

  it("downgrade to Free → cancel at period end, no schedule", async () => {
    mocks.subscriptions.retrieve.mockResolvedValue(sub("price_growth"));
    mocks.subscriptions.update.mockResolvedValue(sub("price_growth", { cancel_at_period_end: true }));
    const res = await call(billingChangePlan, { tier: "free" });
    expect(res.statusCode).toBe(200);
    expect(mocks.subscriptions.update).toHaveBeenCalledWith("sub_1", { cancel_at_period_end: true });
    expect(mocks.schedules.update).not.toHaveBeenCalled();
  });

  it("the same plan is refused", async () => {
    mocks.subscriptions.retrieve.mockResolvedValue(sub("price_growth"));
    const res = await call(billingChangePlan, { tier: "growth" });
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe("same_plan");
  });

  it("an unknown tier is a 400, never a price lookup", async () => {
    const res = await call(billingChangePlan, { tier: "platinum" });
    expect(res.statusCode).toBe(400);
    expect(mocks.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it("no live subscription → 409 (use checkout)", async () => {
    mocks.subRow = { data: null, error: null };
    const res = await call(billingChangePlan, { tier: "pro" });
    expect(res.statusCode).toBe(409);
  });

  it("members cannot change the plan", async () => {
    mocks.requireTenantRole.mockImplementation(async (_a: unknown, _r: unknown, res: ReturnType<typeof mockRes>) => {
      res.status(403).json({ error: { code: "forbidden" } });
      return false;
    });
    const res = await call(billingChangePlan, { tier: "pro" });
    expect(res.statusCode).toBe(403);
    expect(mocks.subscriptions.retrieve).not.toHaveBeenCalled();
  });
});

describe("POST /api/billing/cancel and /resume", () => {
  it("cancel releases any schedule, then cancels at period end", async () => {
    mocks.subscriptions.retrieve.mockResolvedValue(sub("price_growth", { schedule: "sched_2" }));
    mocks.subscriptions.update.mockResolvedValue(sub("price_growth", { cancel_at_period_end: true }));
    const res = await call(billingCancel);
    expect(mocks.schedules.release).toHaveBeenCalledWith("sched_2");
    expect(mocks.subscriptions.update).toHaveBeenCalledWith("sub_1", { cancel_at_period_end: true });
    expect((res.body as { subscription: { cancel_at_period_end: boolean } }).subscription.cancel_at_period_end).toBe(true);
  });

  it("resume undoes a pending cancel", async () => {
    mocks.subscriptions.retrieve.mockResolvedValue(sub("price_growth", { cancel_at_period_end: true }));
    mocks.subscriptions.update.mockResolvedValue(sub("price_growth"));
    const res = await call(billingResume);
    expect(mocks.subscriptions.update).toHaveBeenCalledWith("sub_1", { cancel_at_period_end: false });
    expect((res.body as { subscription: { cancel_at_period_end: boolean } }).subscription.cancel_at_period_end).toBe(false);
  });
});
