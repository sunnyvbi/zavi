
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
    body: undefined as Record<string, unknown> | undefined,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b as Record<string, unknown>; return this; },
  };
  return res;
}

const TENANT = "33333333-3333-3333-3333-333333333333";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ tenant_id: TENANT });
  mocks.getBoolSetting.mockResolvedValue(false);
  mocks.tables = {};
});

async function run(sub: Record<string, unknown> | null) {
  mocks.tables.tenant_subscriptions = { data: sub, error: null };
  const res = mockRes();
  await billingCredits({} as never, res as never);
  return res.body;
}

describe("credits.manage_via_portal", () => {
  it.each(["active", "trialing", "past_due"])(
    "true when customer + subscription present and status=%s",
    async (status) => {
      const body = await run({
        plan: "team",
        status,
        stripe_customer_id: "cus_1",
        stripe_subscription_id: "sub_1",
      });
      expect(body?.manage_via_portal).toBe(true);
    },
  );

  it.each(["canceled", "incomplete", "unpaid", "incomplete_expired"])(
    "false for non-active status=%s",
    async (status) => {
      const body = await run({
        plan: "team",
        status,
        stripe_customer_id: "cus_1",
        stripe_subscription_id: "sub_1",
      });
      expect(body?.manage_via_portal).toBe(false);
    },
  );

  it("false when there is no subscription id (checkout would create one)", async () => {
    const body = await run({
      plan: "full",
      status: "active",
      stripe_customer_id: "cus_1",
      stripe_subscription_id: null,
    });
    expect(body?.manage_via_portal).toBe(false);
  });

  it("false when there is no customer id", async () => {
    const body = await run({
      plan: "full",
      status: "active",
      stripe_customer_id: null,
      stripe_subscription_id: "sub_1",
    });
    expect(body?.manage_via_portal).toBe(false);
  });

  it("false for a comped tenant with no subscription row at all", async () => {
    const body = await run(null);
    expect(body?.manage_via_portal).toBe(false);
  });
});
