
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  getBoolSetting: vi.fn(),
  tables: {} as Record<string, { data: unknown; error: unknown }>,
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/settings", () => ({ getBoolSetting: mocks.getBoolSetting }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from(table: string) {
      const result = mocks.tables[table] ?? { data: null, error: null };
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => Promise.resolve(result),
      };
      return chain;
    },
  }),
}));

import { billingCredits } from "../credits";

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
  return res;
}

function balanceRow(over: Partial<{
  included_allowance: number;
  included_used: number;
  purchased_balance: number;
  reserved: number;
}>) {
  return {
    data: {
      period_start: "2999-01-01",
      period_end: "2999-02-01",
      included_allowance: 40000,
      included_used: 0,
      purchased_balance: 0,
      reserved: 0,
      ...over,
    },
    error: null,
  };
}

beforeEach(() => {
  mocks.requireAuth.mockReset();
  mocks.getBoolSetting.mockReset();
  mocks.tables = {};
  mocks.requireAuth.mockResolvedValue({ tenant_id: "tnt-1" });
  mocks.tables["system_config"] = { data: { blob: { credits_enforced: true } }, error: null };
  mocks.getBoolSetting.mockResolvedValue(true);
});

describe("billingCredits — soft_warn keys off spendability", () => {
  it("topped-up wallet: 80% included used but healthy spendable ⇒ soft_warn:false, pct_used:0.8", async () => {
    mocks.tables["tenant_credit_balances"] = balanceRow({
      included_allowance: 40000,
      included_used: 32000,
      purchased_balance: 32643,
    });
    const res = mockRes();
    await billingCredits({} as never, res as never);
    const b = res.body as Record<string, unknown>;
    expect(b.effective_available_display).toBe(40643);
    expect(b.soft_warn).toBe(false);
    expect(b.pct_used).toBeCloseTo(0.8, 10);
  });

  it("genuinely low: spendable at 20% of allowance ⇒ soft_warn:true", async () => {
    mocks.tables["tenant_credit_balances"] = balanceRow({
      included_allowance: 40000,
      included_used: 32000,
    });
    const res = mockRes();
    await billingCredits({} as never, res as never);
    const b = res.body as Record<string, unknown>;
    expect(b.effective_available_display).toBe(8000);
    expect(b.soft_warn).toBe(true);
  });

  it("reserved eats headroom: included full + small purchased − hold ⇒ soft_warn:true", async () => {
    mocks.tables["tenant_credit_balances"] = balanceRow({
      included_allowance: 40000,
      included_used: 40000,
      purchased_balance: 10000,
      reserved: 4000,
    });
    const res = mockRes();
    await billingCredits({} as never, res as never);
    const b = res.body as Record<string, unknown>;
    expect(b.effective_available_display).toBe(6000);
    expect(b.soft_warn).toBe(true);
  });

  it("flag OFF ⇒ soft_warn:false even when spendable is low", async () => {
    mocks.getBoolSetting.mockResolvedValue(false);
    mocks.tables["tenant_credit_balances"] = balanceRow({ included_allowance: 40000, included_used: 39000 });
    const res = mockRes();
    await billingCredits({} as never, res as never);
    expect((res.body as Record<string, unknown>).soft_warn).toBe(false);
  });

  it("credits NOT enforced ⇒ soft_warn:false even with the flag on and spendable low", async () => {
    mocks.tables["system_config"] = { data: { blob: { credits_enforced: false } }, error: null };
    mocks.tables["tenant_credit_balances"] = balanceRow({ included_allowance: 40000, included_used: 39000 });
    const res = mockRes();
    await billingCredits({} as never, res as never);
    const b = res.body as Record<string, unknown>;
    expect(b.enforced).toBe(false);
    expect(b.soft_warn).toBe(false);
  });
});

describe("billingCredits — three-tier fields", () => {
  const sub = (tier: unknown) => ({
    data: { plan: "team", status: "active", stripe_customer_id: "cus", stripe_subscription_id: "sub", tier },
    error: null,
  });

  it.each([
    ["starter", "Starter"],
    ["growth", "Growth"],
    ["pro", "Pro"],
  ])("tier %s → tier + tier_name, existing fields kept", async (tier, name) => {
    mocks.tables["tenant_subscriptions"] = sub(tier);
    const res = mockRes();
    await billingCredits({} as never, res as never);
    const b = res.body as Record<string, unknown>;
    expect(b.tier).toBe(tier);
    expect(b.tier_name).toBe(name);
    expect(b.plan).toBe("team");
    expect(b).toHaveProperty("effective_available");
  });

  it.each([[null], ["enterprise"], [undefined]])("tier %s → free", async (tier) => {
    mocks.tables["tenant_subscriptions"] = sub(tier);
    const res = mockRes();
    await billingCredits({} as never, res as never);
    const b = res.body as Record<string, unknown>;
    expect(b.tier).toBe("free");
    expect(b.tier_name).toBe("Free");
  });

  it("no subscription row → free", async () => {
    const res = mockRes();
    await billingCredits({} as never, res as never);
    expect((res.body as Record<string, unknown>).tier).toBe("free");
  });
});
