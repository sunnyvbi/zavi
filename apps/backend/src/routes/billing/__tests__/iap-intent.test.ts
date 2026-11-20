
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  requireTenantRole: vi.fn(),
  currentRow: { data: null as unknown, error: null as unknown },
  otherRow: { data: null as unknown, error: null as unknown },
  upsertResult: { error: null as unknown },
  upsert: vi.fn(),
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: mocks.requireTenantRole }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from(table: string) {
      if (table === "tenant_store_bindings") {
        return {
          upsert: (row: unknown, opts: unknown) => {
            mocks.upsert(row, opts);
            return Promise.resolve(mocks.upsertResult);
          },
        };
      }
      let byStoreUser = false;
      const chain = {
        select: () => chain,
        eq: (col: string) => {
          if (col === "store_app_user_id") byStoreUser = true;
          return chain;
        },
        neq: () => chain,
        maybeSingle: () => Promise.resolve(byStoreUser ? mocks.otherRow : mocks.currentRow),
      };
      return chain;
    },
  }),
}));

import { billingIapIntent } from "../iap-intent";

const TENANT = "77777777-7777-7777-7777-777777777777";
const USER = "11111111-1111-1111-1111-111111111111";

function mockRes() {
  return {
    statusCode: 200,
    body: undefined as Record<string, unknown> | undefined,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b as Record<string, unknown>; return this; },
  };
}
async function post() {
  const res = mockRes();
  await billingIapIntent({} as never, res as never);
  return res;
}

type RowOpts = { stripeSub?: string | null; grandfathered?: boolean; revoked?: string | null };
const row = (status: string, source: string | null, o: RowOpts = {}) => ({
  data: {
    status,
    source,
    stripe_subscription_id: o.stripeSub ?? null,
    grandfathered: o.grandfathered ?? false,
    credits_revoked_at: o.revoked ?? null,
  },
  error: null,
});
const errorCode = (res: ReturnType<typeof mockRes>) =>
  ((res.body?.error ?? {}) as { code?: string }).code;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ user_id: USER, tenant_id: TENANT });
  mocks.requireTenantRole.mockResolvedValue(true);
  mocks.currentRow = { data: null, error: null };
  mocks.otherRow = { data: null, error: null };
  mocks.upsertResult = { error: null };
});

describe("POST /api/billing/iap/intent", () => {
  it("stops when the caller is not signed in", async () => {
    mocks.requireAuth.mockResolvedValue(null);
    await post();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("refuses a plain member and writes nothing", async () => {
    mocks.requireTenantRole.mockResolvedValue(false);
    await post();
    expect(mocks.requireTenantRole).toHaveBeenCalledWith(expect.anything(), ["owner", "admin"], expect.anything());
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  describe("allowed", () => {
    it("binds a free workspace that has no subscription row", async () => {
      const res = await post();
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ tenant_id: TENANT });
      expect(mocks.upsert).toHaveBeenCalledTimes(1);
      expect(mocks.upsert.mock.calls[0][0]).toMatchObject({ user_id: USER, tenant_id: TENANT });
      expect(mocks.upsert.mock.calls[0][1]).toEqual({ onConflict: "user_id" });
    });

    it("binds a workspace whose Stripe plan has ended", async () => {
      mocks.currentRow = row("canceled", "stripe", { stripeSub: "sub_1" });
      const res = await post();
      expect(res.statusCode).toBe(200);
    });

    it("binds a workspace whose store plan has ended", async () => {
      mocks.currentRow = row("canceled", "app_store");
      const res = await post();
      expect(res.statusCode).toBe(200);
    });

    it("binds a complimentary workspace, which a paid plan replaces just like on the web", async () => {
      mocks.currentRow = row("active", null);
      const res = await post();
      expect(res.statusCode).toBe(200);
      expect(mocks.upsert).toHaveBeenCalledTimes(1);
    });

    it("allows a person whose other workspace's store plan has ended", async () => {
      mocks.otherRow = row("canceled", "app_store");
      const res = await post();
      expect(res.statusCode).toBe(200);
    });
  });

  describe("refused before the store sheet can open", () => {
    it.each([
      ["active", "stripe"],
      ["trialing", "stripe"],
      ["past_due", "stripe"],
      ["active", null],
    ])("a live web plan (%s, source %s)", async (status, source) => {
      mocks.currentRow = row(status, source, { stripeSub: "sub_1" });
      const res = await post();
      expect(res.statusCode).toBe(409);
      expect(errorCode(res)).toBe("managed_on_web");
      expect(mocks.upsert).not.toHaveBeenCalled();
    });

    it("an old-style web plan that carries no tier", async () => {
      mocks.currentRow = row("active", null, { stripeSub: "sub_legacy" });
      const res = await post();
      expect(errorCode(res)).toBe("managed_on_web");
    });

    it("a lifetime-free workspace", async () => {
      mocks.currentRow = row("active", null, { grandfathered: true });
      const res = await post();
      expect(res.statusCode).toBe(409);
      expect(errorCode(res)).toBe("not_purchasable");
      expect(mocks.upsert).not.toHaveBeenCalled();
    });

    it("a workspace blocked after a refund", async () => {
      mocks.currentRow = row("canceled", "stripe", { revoked: "2026-09-01T00:00:00Z" });
      const res = await post();
      expect(res.statusCode).toBe(409);
      expect(errorCode(res)).toBe("purchases_blocked");
      expect(mocks.upsert).not.toHaveBeenCalled();
    });

    it("a workspace that already has a store plan", async () => {
      mocks.currentRow = row("active", "play_store");
      const res = await post();
      expect(res.statusCode).toBe(409);
      expect(errorCode(res)).toBe("already_subscribed");
      expect(mocks.upsert).not.toHaveBeenCalled();
    });

    it("a person whose store account already pays for another workspace", async () => {
      mocks.otherRow = row("active", "app_store");
      const res = await post();
      expect(res.statusCode).toBe(409);
      expect(errorCode(res)).toBe("store_account_in_use");
      expect(mocks.upsert).not.toHaveBeenCalled();
    });
  });

  describe("database errors", () => {
    it("returns 500 when the subscription read fails", async () => {
      mocks.currentRow = { data: null, error: { message: "db down" } };
      const res = await post();
      expect(res.statusCode).toBe(500);
      expect(errorCode(res)).toBe("internal");
      expect(mocks.upsert).not.toHaveBeenCalled();
    });

    it("returns 500 when the other-workspace read fails", async () => {
      mocks.otherRow = { data: null, error: { message: "db down" } };
      const res = await post();
      expect(res.statusCode).toBe(500);
      expect(mocks.upsert).not.toHaveBeenCalled();
    });

    it("returns 500 when the binding write fails", async () => {
      mocks.upsertResult = { error: { message: "write failed" } };
      const res = await post();
      expect(res.statusCode).toBe(500);
      expect(errorCode(res)).toBe("internal");
    });
  });
});
