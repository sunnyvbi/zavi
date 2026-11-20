
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyBearer: vi.fn(),
  profileMaybeSingle: vi.fn(),
  membershipMaybeSingle: vi.fn(),
}));

vi.mock("../jwt", () => ({ verifyBearer: mocks.verifyBearer }));

vi.mock("@/services/tenants/disabled", () => ({
  readTenantDisabled: async () => false,
  TENANT_DISABLED_CODE: "tenant_disabled",
  TENANT_DISABLED_MESSAGE: "This workspace is disabled. Contact support@zaviagent.com.",
}));

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => {
          if (table === "profiles") {
            return { maybeSingle: mocks.profileMaybeSingle };
          }
          return {
            eq: () => ({ maybeSingle: mocks.membershipMaybeSingle }),
          };
        },
      }),
    }),
  }),
}));

import { authMiddleware, requireAuth } from "../middleware";
import { _clearTenantCacheForTests } from "../tenant-cache";

function mockRes() {
  const res: {
    statusCode: number;
    body: unknown;
    status: (c: number) => typeof res;
    json: (b: unknown) => typeof res;
  } = {
    statusCode: 200,
    body: undefined,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  return res;
}

beforeEach(() => {
  mocks.verifyBearer.mockReset();
  mocks.profileMaybeSingle.mockReset();
  mocks.membershipMaybeSingle.mockReset();
  _clearTenantCacheForTests();
});

describe("authMiddleware", () => {
  it("populates req.auth + calls next() on a valid bearer", async () => {
    mocks.verifyBearer.mockResolvedValueOnce({
      user_id: "user-1",
      access_token: "tok",
    });
    mocks.profileMaybeSingle.mockResolvedValueOnce({
      data: { active_tenant_id: "tnt-1" },
      error: null,
    });
    mocks.membershipMaybeSingle.mockResolvedValueOnce({
      data: { tenant_id: "tnt-1" },
      error: null,
    });

    const req: { auth?: unknown } = {};
    const res = mockRes();
    const next = vi.fn();
    await authMiddleware(req as never, res as never, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.auth).toEqual({
      user_id: "user-1",
      tenant_id: "tnt-1",
      access_token: "tok",
      email: null,
    });
    expect(res.statusCode).toBe(200);
  });

  it("401s + does NOT call next() when verifyBearer fails", async () => {
    mocks.verifyBearer.mockResolvedValueOnce(null);

    const req = {};
    const res = mockRes();
    const next = vi.fn();
    await authMiddleware(req as never, res as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe("unauthenticated");
  });

  it("403s + does NOT call next() when the user has no active tenant", async () => {
    mocks.verifyBearer.mockResolvedValueOnce({
      user_id: "user-1",
      access_token: "tok",
    });
    mocks.profileMaybeSingle.mockResolvedValueOnce({
      data: { active_tenant_id: null },
      error: null,
    });

    const req = {};
    const res = mockRes();
    const next = vi.fn();
    await authMiddleware(req as never, res as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe("no_active_tenant");
  });
});

describe("tenant-resolution cache (auth hot-path egress cut)", () => {
  it("second request for the same user skips BOTH DB reads", async () => {
    mocks.verifyBearer.mockResolvedValue({ user_id: "user-1", access_token: "tok" });
    mocks.profileMaybeSingle.mockResolvedValueOnce({
      data: { active_tenant_id: "tnt-1" },
      error: null,
    });
    mocks.membershipMaybeSingle.mockResolvedValueOnce({
      data: { tenant_id: "tnt-1" },
      error: null,
    });

    const r1 = await requireAuth({} as never, mockRes() as never);
    expect(r1).toEqual({ user_id: "user-1", tenant_id: "tnt-1", access_token: "tok", email: null });
    expect(mocks.profileMaybeSingle).toHaveBeenCalledOnce();
    expect(mocks.membershipMaybeSingle).toHaveBeenCalledOnce();

    const r2 = await requireAuth({} as never, mockRes() as never);
    expect(r2).toEqual({ user_id: "user-1", tenant_id: "tnt-1", access_token: "tok", email: null });
    expect(mocks.verifyBearer).toHaveBeenCalledTimes(2);
    expect(mocks.profileMaybeSingle).toHaveBeenCalledOnce();
    expect(mocks.membershipMaybeSingle).toHaveBeenCalledOnce();
  });

  it("does NOT cache a failed membership check (no sticky 403)", async () => {
    mocks.verifyBearer.mockResolvedValue({ user_id: "user-9", access_token: "tok" });
    mocks.profileMaybeSingle.mockResolvedValue({
      data: { active_tenant_id: "tnt-9" },
      error: null,
    });
    mocks.membershipMaybeSingle.mockResolvedValueOnce({ data: null, error: null });

    const res1 = mockRes();
    const r1 = await requireAuth({} as never, res1 as never);
    expect(r1).toBeNull();
    expect(res1.statusCode).toBe(403);

    mocks.membershipMaybeSingle.mockResolvedValueOnce({
      data: { tenant_id: "tnt-9" },
      error: null,
    });
    const r2 = await requireAuth({} as never, mockRes() as never);
    expect(r2).toEqual({ user_id: "user-9", tenant_id: "tnt-9", access_token: "tok", email: null });
    expect(mocks.membershipMaybeSingle).toHaveBeenCalledTimes(2);
  });
});

describe("X-Eval-Tenant per-request override (membership-gated)", () => {
  const UPCAR = "73db45ff-457e-4541-bc8f-bdb625390204";

  it("overrides tenant to the header value when the caller IS a member", async () => {
    mocks.verifyBearer.mockResolvedValueOnce({ user_id: "user-1", access_token: "tok" });
    mocks.membershipMaybeSingle.mockResolvedValueOnce({ data: { tenant_id: UPCAR }, error: null });

    const req = { headers: { "x-eval-tenant": UPCAR } };
    const res = mockRes();
    const r = await requireAuth(req as never, res as never);

    expect(r).toEqual({ user_id: "user-1", tenant_id: UPCAR, access_token: "tok", email: null, tenant_overridden: true });
    expect(mocks.profileMaybeSingle).not.toHaveBeenCalled();
  });

  it("403s when the caller is NOT a member of the header tenant (no escalation)", async () => {
    mocks.verifyBearer.mockResolvedValueOnce({ user_id: "user-1", access_token: "tok" });
    mocks.membershipMaybeSingle.mockResolvedValueOnce({ data: null, error: null });

    const req = { headers: { "x-eval-tenant": UPCAR } };
    const res = mockRes();
    const r = await requireAuth(req as never, res as never);

    expect(r).toBeNull();
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe("eval_tenant_not_a_member");
  });

  it("400s on a non-UUID header before any DB read", async () => {
    mocks.verifyBearer.mockResolvedValueOnce({ user_id: "user-1", access_token: "tok" });

    const req = { headers: { "x-eval-tenant": "not-a-uuid" } };
    const res = mockRes();
    const r = await requireAuth(req as never, res as never);

    expect(r).toBeNull();
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe("bad_eval_tenant");
    expect(mocks.membershipMaybeSingle).not.toHaveBeenCalled();
  });

  it("does NOT write the override to the active-tenant cache (next normal req re-resolves)", async () => {
    mocks.verifyBearer.mockResolvedValue({ user_id: "user-7", access_token: "tok" });
    mocks.membershipMaybeSingle.mockResolvedValueOnce({ data: { tenant_id: UPCAR }, error: null });
    const rOverride = await requireAuth({ headers: { "x-eval-tenant": UPCAR } } as never, mockRes() as never);
    expect(rOverride?.tenant_id).toBe(UPCAR);

    mocks.profileMaybeSingle.mockResolvedValueOnce({ data: { active_tenant_id: "tnt-real" }, error: null });
    mocks.membershipMaybeSingle.mockResolvedValueOnce({ data: { tenant_id: "tnt-real" }, error: null });
    const rNormal = await requireAuth({ headers: {} } as never, mockRes() as never);
    expect(rNormal?.tenant_id).toBe("tnt-real");
    expect(mocks.profileMaybeSingle).toHaveBeenCalledOnce();
  });
});

describe("requireAuth fast-path when authMiddleware has already run", () => {
  it("short-circuits via req.auth — no Supabase calls", async () => {
    const req: { auth?: unknown } = {
      auth: {
        user_id: "user-1",
        tenant_id: "tnt-1",
        access_token: "tok",
      },
    };
    const res = mockRes();
    const result = await requireAuth(req as never, res as never);
    expect(result).toEqual({
      user_id: "user-1",
      tenant_id: "tnt-1",
      access_token: "tok",
    });
    expect(mocks.verifyBearer).not.toHaveBeenCalled();
    expect(mocks.profileMaybeSingle).not.toHaveBeenCalled();
    expect(mocks.membershipMaybeSingle).not.toHaveBeenCalled();
  });
});
