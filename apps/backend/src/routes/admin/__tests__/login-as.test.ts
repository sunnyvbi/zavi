import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const tok = vi.hoisted(() => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const make = (claims: Record<string, unknown>) => `${b64({ alg: "ES256" })}.${b64(claims)}.sig`;
  const SESSION_ID = "5e551011-0000-4000-8000-00000000abcd";
  return { make, SESSION_ID, ACCESS: make({ sub: "owner-1", session_id: SESSION_ID }) };
});

const state = vi.hoisted(() => ({
  staffThrows: false,
  tenant: { id: "t", slug: "acme", display_name: "Acme" } as
    | { id: string; slug: string; display_name: string | null }
    | null,
  owner: { user_id: "owner-1", created_at: "2026-01-01T00:00:00Z" } as
    | { user_id: string; created_at: string }
    | null,
  member: { user_id: "member-1" } as { user_id: string } | null,
  targetUser: {
    id: "owner-1",
    email: "owner@acme.com",
    app_metadata: {} as Record<string, unknown>,
  } as { id: string; email: string | null; app_metadata: Record<string, unknown> } | null,
  getUserErr: null as { message: string } | null,
  generateLink: {
    data: { properties: { hashed_token: "HASH_abc" } },
    error: null as { message: string } | null,
  },
  generateLinkCalled: false,
  verify: {
    data: {
      session: {
        access_token: tok.ACCESS,
        refresh_token: "REFRESH_tok",
        expires_in: 3600,
        expires_at: 9999,
      },
    },
    error: null as { message: string } | null,
  },
  auditErr: null as { message: string } | null,
  auditArgs: null as Record<string, unknown> | null,
  signedOut: [] as string[],
}));

class FakeStaffError extends Error {
  status = 403;
  constructor() {
    super("not_staff");
  }
}

vi.mock("@/services/auth/staff-middleware", () => ({
  assertStaff: () => {
    if (state.staffThrows) throw new FakeStaffError();
    return { user_id: "staff-1", email: "ravi@upcar.ai" };
  },
}));

vi.mock("@/services/logging/logEvent", () => ({
  logEvent: async () => {},
}));

vi.mock("@/services/supabase", () => {
  class Chain {
    table: string;
    filters: Record<string, unknown> = {};
    constructor(table: string) {
      this.table = table;
    }
    select() {
      return this;
    }
    eq(col: string, val: unknown) {
      this.filters[col] = val;
      return this;
    }
    order() {
      return this;
    }
    limit() {
      return this;
    }
    async maybeSingle() {
      if (this.table === "tenants") return { data: state.tenant, error: null };
      if (this.table === "tenant_users") {
        if (this.filters.role === "owner") return { data: state.owner, error: null };
        return { data: state.member, error: null };
      }
      return { data: null, error: null };
    }
  }
  const svc = {
    from: (table: string) => new Chain(table),
    auth: {
      admin: {
        getUserById: async () => ({
          data: state.targetUser ? { user: state.targetUser } : null,
          error: state.getUserErr,
        }),
        generateLink: async () => {
          state.generateLinkCalled = true;
          return state.generateLink;
        },
        signOut: async (jwt: string) => {
          state.signedOut.push(jwt);
          return { error: null };
        },
      },
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "admin_action_log_append") {
        state.auditArgs = args;
        return { data: state.auditErr ? null : "log-1", error: state.auditErr };
      }
      return { data: null, error: null };
    },
  };
  return {
    serviceClient: () => svc,
    anonClient: () => ({
      auth: { verifyOtp: async () => state.verify },
    }),
  };
});

import { staffLoginAs } from "@/routes/admin/login-as";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";

function mockReqRes(body: unknown) {
  const req = { body } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return { req, res };
}

function payloadOf(res: Response) {
  return (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
}

beforeEach(() => {
  state.staffThrows = false;
  state.tenant = { id: "t", slug: "acme", display_name: "Acme" };
  state.owner = { user_id: "owner-1", created_at: "2026-01-01T00:00:00Z" };
  state.member = { user_id: "member-1" };
  state.targetUser = { id: "owner-1", email: "owner@acme.com", app_metadata: {} };
  state.getUserErr = null;
  state.generateLink = { data: { properties: { hashed_token: "HASH_abc" } }, error: null };
  state.generateLinkCalled = false;
  state.verify = {
    data: {
      session: {
        access_token: tok.ACCESS,
        refresh_token: "REFRESH_tok",
        expires_in: 3600,
        expires_at: 9999,
      },
    },
    error: null,
  };
  state.auditErr = null;
  state.auditArgs = null;
  state.signedOut = [];
});

describe("POST /api/admin/login-as", () => {
  it("happy path → returns customer session + target, audits on_behalf, tokens NOT in audit", async () => {
    const { req, res } = mockReqRes({ tenant_id: TENANT });
    await staffLoginAs(req, res);
    const p = payloadOf(res);
    expect(p.access_token).toBe(tok.ACCESS);
    expect(p.refresh_token).toBe("REFRESH_tok");
    expect(p.target.user_id).toBe("owner-1");
    expect(p.target.email).toBe("owner@acme.com");
    expect(p.target.tenant_id).toBe(TENANT);

    const a = state.auditArgs!;
    expect(a.p_staff_email).toBe("ravi@upcar.ai");
    expect(a.p_tenant_id).toBe(TENANT);
    expect(a.p_action).toBe("login_as");
    expect(a.p_target).toBe("owner@acme.com");
    expect(a.p_on_behalf).toBe(true);
    expect(a.p_after).toEqual({ target_user_id: "owner-1", tenant_slug: "acme", session_id: tok.SESSION_ID });
    for (const v of Object.values(a)) {
      expect(v).not.toBe(tok.ACCESS);
      expect(v).not.toBe("REFRESH_tok");
    }
    expect(JSON.stringify(a)).not.toContain(tok.ACCESS);
    expect(JSON.stringify(a)).not.toContain("REFRESH_tok");
    expect(state.signedOut).toEqual([]);
  });

  it("a minted session with no session_id is signed out and never handed back (no audit)", async () => {
    for (const access of [tok.make({ sub: "owner-1" }), "not-a-jwt", tok.make({ sub: "owner-1", session_id: "" })]) {
      state.verify.data.session.access_token = access;
      state.auditArgs = null;
      state.signedOut = [];
      const { req, res } = mockReqRes({ tenant_id: TENANT });
      await staffLoginAs(req, res);
      expect(res.status).toHaveBeenCalledWith(502);
      const p = payloadOf(res);
      expect(p.error.code).toBe("session_id_missing");
      expect(p.access_token).toBeUndefined();
      expect(state.auditArgs).toBeNull();
      expect(state.signedOut).toEqual([access]);
    }
  });

  it("BLOCKS impersonating a staff account (403, no mint, no audit)", async () => {
    state.targetUser = {
      id: "owner-1",
      email: "otherstaff@zavi.com",
      app_metadata: { role: "staff" },
    };
    const { req, res } = mockReqRes({ tenant_id: TENANT });
    await staffLoginAs(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).error.code).toBe("staff_target_forbidden");
    expect(state.generateLinkCalled).toBe(false);
    expect(state.auditArgs).toBeNull();
  });

  it("a specific user_id must be a MEMBER of the tenant (400, no mint)", async () => {
    state.member = null;
    const { req, res } = mockReqRes({
      tenant_id: TENANT,
      user_id: "11111111-1111-4111-8111-111111111111",
    });
    await staffLoginAs(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).error.code).toBe("not_a_member");
    expect(state.generateLinkCalled).toBe(false);
  });

  it("audit is FAIL-CLOSED — RPC error → 500, session withheld", async () => {
    state.auditErr = { message: "worm down" };
    const { req, res } = mockReqRes({ tenant_id: TENANT });
    await staffLoginAs(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
    const p = payloadOf(res);
    expect(p.error.code).toBe("audit_failed");
    expect(p.access_token).toBeUndefined();
    expect(state.generateLinkCalled).toBe(true);
    expect(state.signedOut).toEqual([tok.ACCESS]);
  });

  it("target with no email → 400 (cannot mint), no generateLink", async () => {
    state.targetUser = { id: "owner-1", email: null, app_metadata: {} };
    const { req, res } = mockReqRes({ tenant_id: TENANT });
    await staffLoginAs(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).error.code).toBe("target_no_email");
    expect(state.generateLinkCalled).toBe(false);
  });

  it("tenant with no owner → 404, no mint", async () => {
    state.owner = null;
    const { req, res } = mockReqRes({ tenant_id: TENANT });
    await staffLoginAs(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(payloadOf(res).error.code).toBe("no_owner");
    expect(state.generateLinkCalled).toBe(false);
  });

  it("tenant not found → 404, no mint", async () => {
    state.tenant = null;
    const { req, res } = mockReqRes({ tenant_id: TENANT });
    await staffLoginAs(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(payloadOf(res).error.code).toBe("tenant_not_found");
    expect(state.generateLinkCalled).toBe(false);
  });

  it("rejects a non-uuid tenant_id (400, no mint)", async () => {
    const { req, res } = mockReqRes({ tenant_id: "not-a-uuid" });
    await staffLoginAs(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).error.code).toBe("bad_request");
    expect(state.generateLinkCalled).toBe(false);
  });

  it("staff-gated — assertStaff throwing prevents any mint", async () => {
    state.staffThrows = true;
    const { req, res } = mockReqRes({ tenant_id: TENANT });
    await expect(staffLoginAs(req, res)).rejects.toBeInstanceOf(FakeStaffError);
    expect(state.generateLinkCalled).toBe(false);
    expect(state.auditArgs).toBeNull();
  });
});
