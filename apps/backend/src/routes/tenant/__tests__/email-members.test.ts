
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  requireTenantRole: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: mocks.requireTenantRole }));
vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: vi.fn(() => ({ rpc: mocks.rpc })),
}));

import { listEmailMembers, setEmailMemberEnabled } from "../email-members";

const mkRes = () => {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; body: any };
};
const mkReq = (over: Partial<Request> = {}) => ({ body: {}, params: {}, ...over }) as Request;

const UID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ user_id: "u1", tenant_id: "t1", access_token: "tok" });
  mocks.requireTenantRole.mockResolvedValue(true);
  mocks.rpc.mockResolvedValue({ data: null, error: null });
});

describe("GET — any member may read who is switched off", () => {
  it("returns the disabled ids, no role check", async () => {
    mocks.rpc.mockResolvedValue({ data: [UID], error: null });
    const res = mkRes();
    await listEmailMembers(mkReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ disabled_user_ids: [UID] });
    expect(mocks.requireTenantRole).not.toHaveBeenCalled();
  });

  it("an empty set means everyone is ON (absence = enabled)", async () => {
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    const res = mkRes();
    await listEmailMembers(mkReq(), res);
    expect(res.body).toEqual({ disabled_user_ids: [] });
  });
});

describe("POST — owner|admin only, gate precedes the write", () => {
  it("a plain member cannot toggle — the RPC is never called", async () => {
    mocks.requireTenantRole.mockResolvedValue(false);
    const res = mkRes();
    await setEmailMemberEnabled(mkReq({ body: { user_id: UID, enabled: false } }), res);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("asks for owner|admin specifically", async () => {
    await setEmailMemberEnabled(mkReq({ body: { user_id: UID, enabled: false } }), mkRes());
    expect(mocks.requireTenantRole).toHaveBeenCalledWith(
      expect.anything(),
      ["owner", "admin"],
      expect.anything(),
    );
  });

  it("disables a member", async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    const res = mkRes();
    await setEmailMemberEnabled(mkReq({ body: { user_id: UID, enabled: false } }), res);
    expect(mocks.rpc).toHaveBeenCalledWith("set_email_member_enabled", {
      p_user_id: UID,
      p_enabled: false,
    });
    expect(res.body).toEqual({ user_id: UID, enabled: false });
  });

  it("re-enables a member", async () => {
    mocks.rpc.mockResolvedValue({ data: true, error: null });
    const res = mkRes();
    await setEmailMemberEnabled(mkReq({ body: { user_id: UID, enabled: true } }), res);
    expect(res.body).toEqual({ user_id: UID, enabled: true });
  });

  it.each([
    ["missing user_id", { enabled: false }],
    ["non-uuid user_id", { user_id: "nope", enabled: false }],
    ["missing enabled", { user_id: UID }],
    ["non-boolean enabled", { user_id: UID, enabled: "false" }],
    ["unknown key", { user_id: UID, enabled: false, tenant_id: "t2" }],
  ])("400s on %s without calling the RPC", async (_l, body) => {
    const res = mkRes();
    await setEmailMemberEnabled(mkReq({ body }), res);
    expect(res.statusCode).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("ignores a client-supplied tenant_id (rejects the body outright)", async () => {
    const res = mkRes();
    await setEmailMemberEnabled(mkReq({ body: { user_id: UID, enabled: false, tenant_id: "other" } }), res);
    expect(res.statusCode).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("maps target_not_a_member to 404", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "target_not_a_member" } });
    const res = mkRes();
    await setEmailMemberEnabled(mkReq({ body: { user_id: UID, enabled: false } }), res);
    expect(res.statusCode).toBe(404);
    expect(res.body.error.code).toBe("not_a_member");
  });

  it("maps admin_only to 403", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "admin_only" } });
    const res = mkRes();
    await setEmailMemberEnabled(mkReq({ body: { user_id: UID, enabled: false } }), res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe("admin_only");
  });

  it("maps owner_email_always_on to 409 (owners can never be switched off)", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "owner_email_always_on" } });
    const res = mkRes();
    await setEmailMemberEnabled(mkReq({ body: { user_id: UID, enabled: false } }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe("owner_email_always_on");
  });
});
