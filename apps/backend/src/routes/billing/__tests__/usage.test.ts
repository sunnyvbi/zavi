
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  tables: {} as Record<string, { data: unknown; error: unknown }>,
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
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

import { billingUsage } from "../usage";

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
  return res;
}

beforeEach(() => {
  mocks.requireAuth.mockReset();
  mocks.tables = {};
  mocks.requireAuth.mockResolvedValue({ tenant_id: "tnt-1" });
});

describe("billingUsage", () => {
  it("no sub row → free defaults (allowance 5), no credit row → 0 used", async () => {
    const res = mockRes();
    await billingUsage({} as never, res as never);
    expect(res.statusCode).toBe(200);
    const b = res.body as Record<string, unknown>;
    expect(b.plan).toBe("free");
    expect(b.included_allowance).toBe(5);
    expect(b.included_used).toBe(0);
    expect(b.included_remaining).toBe(5);
    expect(b.total_remaining).toBe(5);
    expect(b.enforced).toBe(false);
  });

  it("derives allowance from PLAN, ignoring a stale stored included_allowance", async () => {
    mocks.tables["tenant_subscriptions"] = { data: { plan: "solo", status: "active" }, error: null };
    mocks.tables["tenant_build_credits"] = {
      data: { period_start: "2999-01-01", period_end: "2999-02-01", included_allowance: 999999, included_used: 7, purchased_balance: 3 },
      error: null,
    };
    const res = mockRes();
    await billingUsage({} as never, res as never);
    const b = res.body as Record<string, unknown>;
    expect(b.included_allowance).toBe(50);
    expect(b.included_used).toBe(7);
    expect(b.included_remaining).toBe(43);
    expect(b.purchased_balance).toBe(3);
    expect(b.total_remaining).toBe(46);
  });

  it("rolled-over period (period_end in the past) shows 0 used, not last month's", async () => {
    mocks.tables["tenant_subscriptions"] = { data: { plan: "team", status: "active" }, error: null };
    mocks.tables["tenant_build_credits"] = {
      data: { period_start: "2020-01-01", period_end: "2020-02-01", included_allowance: 250, included_used: 200, purchased_balance: 5 },
      error: null,
    };
    const res = mockRes();
    await billingUsage({} as never, res as never);
    const b = res.body as Record<string, unknown>;
    expect(b.included_used).toBe(0);
    expect(b.included_remaining).toBe(250);
    expect(b.purchased_balance).toBe(5);
    expect(b.total_remaining).toBe(255);
  });

  it("surfaces enforced=true when the flag is on", async () => {
    mocks.tables["system_config"] = { data: { blob: { build_credits_enforced: true } }, error: null };
    const res = mockRes();
    await billingUsage({} as never, res as never);
    expect((res.body as Record<string, unknown>).enforced).toBe(true);
  });

  it("500s on a subscription read error without leaking detail shape", async () => {
    mocks.tables["tenant_subscriptions"] = { data: null, error: { message: "boom" } };
    const res = mockRes();
    await billingUsage({} as never, res as never);
    expect(res.statusCode).toBe(500);
    expect((res.body as { error: { code: string } }).error.code).toBe("internal");
  });
});
