import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  teamsEnabled: vi.fn(),
  rpc: vi.fn(),
  maybeSingle: vi.fn(),
  requireTenantRole: vi.fn(),
  tenantRpc: vi.fn(),
}));

vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: (...a: unknown[]) => mocks.requireTenantRole(...a),
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: (...a: unknown[]) => mocks.tenantRpc(...a),
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: (...a: unknown[]) => mocks.requireAuth(...a),
}));
vi.mock("@/services/connectors/teams/adapter", () => ({
  teamsEnabled: () => mocks.teamsEnabled(),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: () => mocks.maybeSingle() }),
        }),
      }),
    }),
    rpc: (...a: unknown[]) => mocks.rpc(...a),
  }),
}));

import { teamsBind, teamsDisconnect, teamsStatus } from "../teams";

function mkRes() {
  const res: Record<string, unknown> = {};
  res.statusCode = 200;
  res.status = vi.fn((c: number) => { res.statusCode = c; return res; });
  res.json = vi.fn((b: unknown) => { res.body = b; return res; });
  return res as unknown as { statusCode: number; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn>; body: unknown };
}

const AUTH = { user_id: "u1", tenant_id: "t1", access_token: "tok" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue(AUTH);
  mocks.teamsEnabled.mockReturnValue(true);
});

describe("teamsStatus", () => {
  it("reports configured:false (surface off) without touching the DB", async () => {
    mocks.teamsEnabled.mockReturnValue(false);
    const res = mkRes();
    await teamsStatus({} as never, res as never);
    expect(res.body).toEqual({ configured: false, connected: false });
    expect(mocks.maybeSingle).not.toHaveBeenCalled();
  });

  it("reports connected:true when an enabled mapping exists", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: { status: "enabled" } });
    const res = mkRes();
    await teamsStatus({} as never, res as never);
    expect(res.body).toEqual({ configured: true, connected: true });
  });

  it("reports connected:false when no mapping", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: null });
    const res = mkRes();
    await teamsStatus({} as never, res as never);
    expect(res.body).toEqual({ configured: true, connected: false });
  });
});

describe("teamsBind", () => {
  it("503s when the surface is disabled (SAFE-INERT — stale code can't bind)", async () => {
    mocks.teamsEnabled.mockReturnValue(false);
    const res = mkRes();
    await teamsBind({ body: { bind_code: "AAAA-BBBB" } } as never, res as never);
    expect(res.statusCode).toBe(503);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("400s on a missing bind code", async () => {
    const res = mkRes();
    await teamsBind({ body: {} } as never, res as never);
    expect(res.statusCode).toBe(400);
  });

  it("403s a non-admin member (tenant-wide binding is an admin action)", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: { role: "member" } });
    const res = mkRes();
    await teamsBind({ body: { bind_code: "AAAA-BBBB" } } as never, res as never);
    expect(res.statusCode).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("binds for an owner — tenant_id from the SESSION, code from the body (trust boundary)", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: { role: "owner" } });
    mocks.rpc.mockResolvedValue({ data: "ok" });
    const res = mkRes();
    await teamsBind({ body: { bind_code: "AAAA-BBBB" } } as never, res as never);
    expect(mocks.rpc).toHaveBeenCalledWith("confirm_teams_binding", {
      p_tenant_id: "t1",
      p_bind_code: "AAAA-BBBB",
    });
    expect(res.body).toEqual({ ok: true, connected: true });
  });

  it("409s the cross-tenant hijack guard (m365 already bound elsewhere)", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: { role: "admin" } });
    mocks.rpc.mockResolvedValue({ data: "m365_already_bound" });
    const res = mkRes();
    await teamsBind({ body: { bind_code: "AAAA-BBBB" } } as never, res as never);
    expect(res.statusCode).toBe(409);
  });

  it("410s an invalid/expired code", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: { role: "admin" } });
    mocks.rpc.mockResolvedValue({ data: "invalid_or_expired" });
    const res = mkRes();
    await teamsBind({ body: { bind_code: "ZZZZ-ZZZZ" } } as never, res as never);
    expect(res.statusCode).toBe(410);
  });
});

describe("teamsDisconnect", () => {
  it("unbinds the SESSION tenant for an owner/admin", async () => {
    mocks.requireTenantRole.mockResolvedValue(true);
    mocks.tenantRpc.mockResolvedValue({ data: 1, error: null });
    const res = mkRes();
    await teamsDisconnect({ body: { tenant_id: "someone-else" } } as never, res as never);
    expect(mocks.tenantRpc).toHaveBeenCalledWith("t1", "unset_teams_connection", {});
    expect(res.body).toEqual({ ok: true, connected: false });
  });

  it("does nothing when the role gate refuses", async () => {
    mocks.requireTenantRole.mockResolvedValue(false);
    const res = mkRes();
    await teamsDisconnect({} as never, res as never);
    expect(mocks.tenantRpc).not.toHaveBeenCalled();
  });
});
