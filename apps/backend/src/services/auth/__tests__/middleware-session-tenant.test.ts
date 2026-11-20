
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyBearer: vi.fn(),
  profileMaybeSingle: vi.fn(),
  membershipMaybeSingle: vi.fn(),
  getSessionTenant: vi.fn(),
  setSessionTenant: vi.fn(),
  readTenantDisabled: vi.fn(),
}));

vi.mock("@/services/tenants/disabled", () => ({
  readTenantDisabled: mocks.readTenantDisabled,
  TENANT_DISABLED_CODE: "tenant_disabled",
  TENANT_DISABLED_MESSAGE: "This workspace is disabled. Contact support@zaviagent.com.",
}));

vi.mock("../jwt", () => ({ verifyBearer: mocks.verifyBearer }));

vi.mock("@/services/tenants/session-tenant", () => ({
  getSessionTenant: mocks.getSessionTenant,
  setSessionTenant: mocks.setSessionTenant,
}));

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => {
          if (table === "profiles") {
            return { maybeSingle: mocks.profileMaybeSingle };
          }
          return { eq: () => ({ maybeSingle: mocks.membershipMaybeSingle }) };
        },
      }),
    }),
  }),
}));

import { requireAuth } from "../middleware";
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

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  _clearTenantCacheForTests();
  mocks.setSessionTenant.mockResolvedValue(undefined);
  mocks.readTenantDisabled.mockResolvedValue(false);
});

describe("per-session active tenant", () => {
  it("THE BUG: two browsers on the same account resolve DIFFERENT companies", async () => {
    mocks.profileMaybeSingle.mockResolvedValue({
      data: { active_tenant_id: TENANT_A },
      error: null,
    });
    mocks.membershipMaybeSingle.mockImplementation(() =>
      Promise.resolve({ data: { tenant_id: "member" }, error: null }),
    );
    mocks.getSessionTenant.mockImplementation((sid: string) =>
      Promise.resolve(sid === "browser-A" ? TENANT_A : TENANT_B),
    );

    mocks.verifyBearer.mockResolvedValueOnce({
      user_id: "u1",
      access_token: "tok",
      session_id: "browser-A",
    });
    const a = await requireAuth({ headers: {} } as never, mockRes() as never);

    mocks.verifyBearer.mockResolvedValueOnce({
      user_id: "u1",
      access_token: "tok",
      session_id: "browser-B",
    });
    const b = await requireAuth({ headers: {} } as never, mockRes() as never);

    expect(a?.tenant_id).toBe(TENANT_A);
    expect(b?.tenant_id).toBe(TENANT_B);
    expect(a?.tenant_id).not.toBe(b?.tenant_id);
  });

  it("the session pin WINS over the per-user default (profiles is not consulted)", async () => {
    mocks.getSessionTenant.mockResolvedValueOnce(TENANT_B);
    mocks.membershipMaybeSingle.mockResolvedValueOnce({
      data: { tenant_id: TENANT_B },
      error: null,
    });
    mocks.verifyBearer.mockResolvedValueOnce({
      user_id: "u1",
      access_token: "tok",
      session_id: "s1",
    });

    const r = await requireAuth({ headers: {} } as never, mockRes() as never);

    expect(r?.tenant_id).toBe(TENANT_B);
    expect(mocks.profileMaybeSingle).not.toHaveBeenCalled();
    expect(mocks.setSessionTenant).not.toHaveBeenCalled();
  });

  it("an UNPINNED session falls back to the default AND self-pins to it", async () => {
    mocks.getSessionTenant.mockResolvedValueOnce(null);
    mocks.profileMaybeSingle.mockResolvedValueOnce({
      data: { active_tenant_id: TENANT_A },
      error: null,
    });
    mocks.membershipMaybeSingle.mockResolvedValueOnce({
      data: { tenant_id: TENANT_A },
      error: null,
    });
    mocks.verifyBearer.mockResolvedValueOnce({
      user_id: "u1",
      access_token: "tok",
      session_id: "legacy-session",
    });

    const r = await requireAuth({ headers: {} } as never, mockRes() as never);

    expect(r?.tenant_id).toBe(TENANT_A);
    expect(mocks.setSessionTenant).toHaveBeenCalledWith(
      "legacy-session",
      "u1",
      TENANT_A,
    );
  });

  it("MIGRATION EDGE: an unpinned legacy session pins to its OWN claim, not the shared default", async () => {
    mocks.getSessionTenant.mockResolvedValueOnce(null);
    mocks.membershipMaybeSingle.mockResolvedValueOnce({
      data: { tenant_id: TENANT_B },
      error: null,
    });
    mocks.verifyBearer.mockResolvedValueOnce({
      user_id: "u1",
      access_token: "tok",
      session_id: "legacy-browser-B",
      claim_tenant_id: TENANT_B,
    });

    const r = await requireAuth({ headers: {} } as never, mockRes() as never);

    expect(r?.tenant_id).toBe(TENANT_B);
    expect(mocks.profileMaybeSingle).not.toHaveBeenCalled();
    expect(mocks.setSessionTenant).toHaveBeenCalledWith(
      "legacy-browser-B",
      "u1",
      TENANT_B,
    );
  });

  it("a stale claim is NOT an authorization — membership is still re-checked", async () => {
    mocks.getSessionTenant.mockResolvedValueOnce(null);
    mocks.membershipMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    mocks.verifyBearer.mockResolvedValueOnce({
      user_id: "u1",
      access_token: "tok",
      session_id: "s1",
      claim_tenant_id: TENANT_B,
    });

    const res = mockRes();
    const r = await requireAuth({ headers: {} } as never, res as never);

    expect(r).toBeNull();
    expect(res.statusCode).toBe(403);
    expect(mocks.setSessionTenant).not.toHaveBeenCalled();
  });

  it("a pin is NOT an authorization — a revoked membership still 403s", async () => {
    mocks.getSessionTenant.mockResolvedValueOnce(TENANT_B);
    mocks.membershipMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    mocks.verifyBearer.mockResolvedValueOnce({
      user_id: "u1",
      access_token: "tok",
      session_id: "s1",
    });

    const res = mockRes();
    const r = await requireAuth({ headers: {} } as never, res as never);

    expect(r).toBeNull();
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe(
      "membership_revoked",
    );
  });

  it("a failed pin read degrades to the default instead of 500-ing the request", async () => {
    mocks.getSessionTenant.mockResolvedValueOnce(null);
    mocks.profileMaybeSingle.mockResolvedValueOnce({
      data: { active_tenant_id: TENANT_A },
      error: null,
    });
    mocks.membershipMaybeSingle.mockResolvedValueOnce({
      data: { tenant_id: TENANT_A },
      error: null,
    });
    mocks.verifyBearer.mockResolvedValueOnce({
      user_id: "u1",
      access_token: "tok",
      session_id: "s1",
    });

    const res = mockRes();
    const r = await requireAuth({ headers: {} } as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(r?.tenant_id).toBe(TENANT_A);
  });

  it("a failed self-pin still authorizes the request (best-effort, never a 401)", async () => {
    mocks.getSessionTenant.mockResolvedValueOnce(null);
    mocks.setSessionTenant.mockRejectedValueOnce(new Error("db down"));
    mocks.profileMaybeSingle.mockResolvedValueOnce({
      data: { active_tenant_id: TENANT_A },
      error: null,
    });
    mocks.membershipMaybeSingle.mockResolvedValueOnce({
      data: { tenant_id: TENANT_A },
      error: null,
    });
    mocks.verifyBearer.mockResolvedValueOnce({
      user_id: "u1",
      access_token: "tok",
      session_id: "s1",
    });

    const res = mockRes();
    const r = await requireAuth({ headers: {} } as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(r?.tenant_id).toBe(TENANT_A);
  });

  it("a token with NO session_id behaves exactly as before (profiles only, no pin)", async () => {
    mocks.profileMaybeSingle.mockResolvedValueOnce({
      data: { active_tenant_id: TENANT_A },
      error: null,
    });
    mocks.membershipMaybeSingle.mockResolvedValueOnce({
      data: { tenant_id: TENANT_A },
      error: null,
    });
    mocks.verifyBearer.mockResolvedValueOnce({
      user_id: "u1",
      access_token: "tok",
      session_id: null,
    });

    const r = await requireAuth({ headers: {} } as never, mockRes() as never);

    expect(r?.tenant_id).toBe(TENANT_A);
    expect(mocks.getSessionTenant).not.toHaveBeenCalled();
    expect(mocks.setSessionTenant).not.toHaveBeenCalled();
  });

  it("browser B's cached resolution never answers for browser A", async () => {
    mocks.membershipMaybeSingle.mockImplementation(() =>
      Promise.resolve({ data: { tenant_id: "member" }, error: null }),
    );
    mocks.getSessionTenant.mockImplementation((sid: string) =>
      Promise.resolve(sid === "browser-A" ? TENANT_A : TENANT_B),
    );

    mocks.verifyBearer.mockResolvedValue({
      user_id: "u1",
      access_token: "tok",
      session_id: "browser-A",
    });
    await requireAuth({ headers: {} } as never, mockRes() as never);

    mocks.verifyBearer.mockResolvedValue({
      user_id: "u1",
      access_token: "tok",
      session_id: "browser-B",
    });
    const b = await requireAuth({ headers: {} } as never, mockRes() as never);

    expect(b?.tenant_id).toBe(TENANT_B);
  });
});

describe("disabled workspace (staff Disable workspace)", () => {
  function asMember() {
    mocks.getSessionTenant.mockResolvedValue(TENANT_A);
    mocks.membershipMaybeSingle.mockResolvedValue({ data: { tenant_id: TENANT_A }, error: null });
    mocks.verifyBearer.mockResolvedValue({ user_id: "u1", access_token: "tok", session_id: "s1" });
  }

  it("fresh path: a disabled tenant 403s with tenant_disabled and is never cached or pinned", async () => {
    asMember();
    mocks.getSessionTenant.mockResolvedValue(null);
    mocks.profileMaybeSingle.mockResolvedValue({ data: { active_tenant_id: TENANT_A }, error: null });
    mocks.readTenantDisabled.mockResolvedValue(true);
    const res = mockRes();
    const r = await requireAuth({ headers: {} } as never, res as never);
    expect(r).toBeNull();
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe("tenant_disabled");
    expect(mocks.readTenantDisabled).toHaveBeenCalledWith(TENANT_A);
    expect(mocks.setSessionTenant).not.toHaveBeenCalled();

    mocks.readTenantDisabled.mockResolvedValue(false);
    const again = await requireAuth({ headers: {} } as never, mockRes() as never);
    expect(again?.tenant_id).toBe(TENANT_A);
  });

  it("cache-hit path: a tenant disabled AFTER it was cached still 403s", async () => {
    asMember();
    const first = await requireAuth({ headers: {} } as never, mockRes() as never);
    expect(first?.tenant_id).toBe(TENANT_A);
    mocks.membershipMaybeSingle.mockClear();

    mocks.readTenantDisabled.mockResolvedValue(true);
    const res = mockRes();
    const r = await requireAuth({ headers: {} } as never, res as never);
    expect(r).toBeNull();
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe("tenant_disabled");
    expect(mocks.membershipMaybeSingle).not.toHaveBeenCalled();
  });

  it("an unreadable disabled flag answers 503, never lets the request through", async () => {
    asMember();
    mocks.readTenantDisabled.mockResolvedValue(null);
    const res = mockRes();
    const r = await requireAuth({ headers: {} } as never, res as never);
    expect(r).toBeNull();
    expect(res.statusCode).toBe(503);
    expect((res.body as { error: { code: string } }).error.code).toBe("tenant_status_unavailable");
  });

  it("X-Eval-Tenant override to a disabled tenant 403s too", async () => {
    asMember();
    mocks.readTenantDisabled.mockImplementation((tid: string) => Promise.resolve(tid === TENANT_B));
    mocks.membershipMaybeSingle.mockResolvedValue({ data: { tenant_id: TENANT_B }, error: null });
    const res = mockRes();
    const r = await requireAuth({ headers: { "x-eval-tenant": TENANT_B } } as never, res as never);
    expect(r).toBeNull();
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe("tenant_disabled");
  });
});
