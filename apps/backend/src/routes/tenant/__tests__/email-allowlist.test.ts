
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

import {
  listEmailAllowlist,
  addEmailAllowlistEntry,
  removeEmailAllowlistEntry,
} from "../email-allowlist";

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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ user_id: "u1", tenant_id: "t1", access_token: "tok" });
  mocks.requireTenantRole.mockResolvedValue(true);
  mocks.rpc.mockResolvedValue({ data: null, error: null });
});

describe("GET — any member may read", () => {
  it("returns entries without a role check", async () => {
    mocks.rpc.mockResolvedValue({
      data: [{ id: "e1", kind: "domain", value: "acme.com", created_at: "now" }],
      error: null,
    });
    const res = mkRes();
    await listEmailAllowlist(mkReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(mocks.requireTenantRole).not.toHaveBeenCalled();
  });

  it("401s when unauthenticated (requireAuth writes the body)", async () => {
    mocks.requireAuth.mockResolvedValue(null);
    const res = mkRes();
    await listEmailAllowlist(mkReq(), res);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe("POST — owner|admin only, and the gate precedes the write", () => {
  it("a plain member cannot add — the RPC is never called", async () => {
    mocks.requireTenantRole.mockResolvedValue(false);
    const res = mkRes();
    await addEmailAllowlistEntry(mkReq({ body: { value: "ops@acme.com" } }), res);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("asks for owner|admin specifically", async () => {
    await addEmailAllowlistEntry(mkReq({ body: { value: "ops@acme.com" } }), mkRes());
    expect(mocks.requireTenantRole).toHaveBeenCalledWith(
      expect.anything(),
      ["owner", "admin"],
      expect.anything(),
    );
  });

  it("adds a valid address, canonicalized", async () => {
    mocks.rpc.mockResolvedValue({ data: "new-id", error: null });
    const res = mkRes();
    await addEmailAllowlistEntry(mkReq({ body: { value: "  OPS@Acme.COM " } }), res);
    expect(res.statusCode).toBe(201);
    expect(mocks.rpc).toHaveBeenCalledWith("add_email_allowlist_entry", {
      p_kind: "address",
      p_value: "ops@acme.com",
    });
  });

  it("adds a bare domain as kind=domain", async () => {
    mocks.rpc.mockResolvedValue({ data: "new-id", error: null });
    await addEmailAllowlistEntry(mkReq({ body: { value: "Acme.com." } }), mkRes());
    expect(mocks.rpc).toHaveBeenCalledWith("add_email_allowlist_entry", {
      p_kind: "domain",
      p_value: "acme.com",
    });
  });

  it("REFUSES a freemail wildcard, explains why, and never calls the RPC", async () => {
    const res = mkRes();
    await addEmailAllowlistEntry(mkReq({ body: { value: "gmail.com" } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe("public_domain");
    expect(res.body.error.message).toContain("anyone with a gmail.com address");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("allows a freemail ADDRESS (one person, not a wildcard)", async () => {
    mocks.rpc.mockResolvedValue({ data: "new-id", error: null });
    const res = mkRes();
    await addEmailAllowlistEntry(mkReq({ body: { value: "ravi@gmail.com" } }), res);
    expect(res.statusCode).toBe(201);
  });

  it("REFUSES our own domain", async () => {
    const res = mkRes();
    await addEmailAllowlistEntry(mkReq({ body: { value: "inbox.zaviagent.com" } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe("own_domain");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["empty body", {}],
    ["blank value", { value: "   " }],
    ["unknown key", { value: "a@b.com", kind: "domain" }],
  ])("400s on %s without calling the RPC", async (_label, body) => {
    const res = mkRes();
    await addEmailAllowlistEntry(mkReq({ body }), res);
    expect(res.statusCode).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("maps the definer's admin_only to 403", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "admin_only" } });
    const res = mkRes();
    await addEmailAllowlistEntry(mkReq({ body: { value: "ops@acme.com" } }), res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe("admin_only");
  });

  it("maps allowlist_cap_reached to 409", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "allowlist_cap_reached" } });
    const res = mkRes();
    await addEmailAllowlistEntry(mkReq({ body: { value: "ops@acme.com" } }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe("cap_reached");
  });
});

describe("DELETE", () => {
  it("a plain member cannot remove — the RPC is never called", async () => {
    mocks.requireTenantRole.mockResolvedValue(false);
    const res = mkRes();
    await removeEmailAllowlistEntry(mkReq({ params: { id: crypto.randomUUID() } }), res);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("400s a non-uuid id without calling the RPC", async () => {
    const res = mkRes();
    await removeEmailAllowlistEntry(mkReq({ params: { id: "not-a-uuid" } }), res);
    expect(res.statusCode).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("reports removed:false for a foreign/missing id (indistinguishable — no probing)", async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    const res = mkRes();
    await removeEmailAllowlistEntry(mkReq({ params: { id: crypto.randomUUID() } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ removed: false });
  });

  it("reports removed:true on a real delete", async () => {
    mocks.rpc.mockResolvedValue({ data: true, error: null });
    const res = mkRes();
    await removeEmailAllowlistEntry(mkReq({ params: { id: crypto.randomUUID() } }), res);
    expect(res.body).toEqual({ removed: true });
  });
});
