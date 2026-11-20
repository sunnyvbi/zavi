
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const t1 = "00000000-0000-0000-0000-000000000001";
const t2 = "00000000-0000-0000-0000-000000000002";
const ownerId = "10000000-0000-0000-0000-000000000001";
const inviteId = "20000000-0000-4000-8000-000000000001";

const state = {
  auth: {
    user_id: ownerId,
    tenant_id: t1,
    access_token: "fake-jwt",
  } as { user_id: string; tenant_id: string; access_token: string } | null,
  rpcCalls: [] as Array<{ name: string; args: unknown }>,
  rpcReturns: {} as Record<string, { data: unknown; error: { code?: string; message: string } | null }>,
  inviteEmailThrows: false,
  inviteEmailCalls: [] as Array<{ email: string; acceptUrl: string; inviterLabel?: string; tenantName?: string | null }>,
  senderLookups: [] as Array<{ tenant_id: string; inviter_user_id: string | null }>,
  invite: null as
    | {
        id: string;
        email: string;
        accepted_at: string | null;
        revoked_at: string | null;
        tenant_id?: string;
        invited_by?: string | null;
      }
    | null,
  storedInvite: null as { tenant_id: string; invited_by: string | null } | null,
};

function resetState() {
  state.auth = { user_id: ownerId, tenant_id: t1, access_token: "fake-jwt" };
  state.rpcCalls = [];
  state.rpcReturns = {
    invite_member: { data: inviteId, error: null },
    revoke_invite: { data: null, error: null },
    accept_invite: { data: null, error: null },
  };
  state.inviteEmailThrows = false;
  state.inviteEmailCalls = [];
  state.senderLookups = [];
  state.invite = null;
  state.storedInvite = { tenant_id: t1, invited_by: ownerId };
}

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async (_req: Request, res: Response) => {
    if (!state.auth) {
      res.status(401).json({ error: { code: "unauthenticated" } });
      return null;
    }
    return state.auth;
  }),
}));

vi.mock("@/services/auth/jwt", () => ({
  verifyBearer: vi.fn(async () =>
    state.auth ? { user_id: state.auth.user_id, access_token: state.auth.access_token } : null,
  ),
}));

function bearerClientStub(): unknown {
  return {
    rpc(name: string, args: unknown) {
      state.rpcCalls.push({ name, args });
      const ret = state.rpcReturns[name] ?? { data: null, error: null };
      return Promise.resolve(ret);
    },
  };
}

function serviceClientStub(): unknown {
  return {
    from(_table: string) {
      let cols = "";
      const builder = {
        select(c: string) {
          cols = c;
          return builder;
        },
        eq(_col: string, _val: unknown) {
          return builder;
        },
        is(_col: string, _val: unknown) {
          return builder;
        },
        async maybeSingle() {
          if (cols === "tenant_id, invited_by") return { data: state.storedInvite, error: null };
          return { data: state.invite, error: null };
        },
        then(ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) {
          return Promise.resolve({ data: [], error: null }).then(ok, bad);
        },
      };
      return builder;
    },
    rpc: async () => ({ data: false, error: null }),
  };
}

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => bearerClientStub(),
  serviceClient: () => serviceClientStub(),
}));

vi.mock("@/services/auth/tenant-cache", () => ({
  invalidateCachedTenant: vi.fn(),
}));

vi.mock("express-rate-limit", () => ({
  default: () => (_req: Request, _res: Response, next: () => void) => next(),
}));

vi.mock("@/email/sendAuthEmail", () => ({
  resolveInviteSender: vi.fn(async (tenant_id: string, inviter_user_id: string | null) => {
    state.senderLookups.push({ tenant_id, inviter_user_id });
    return { tenantName: `Workspace ${tenant_id.slice(-1)}`, inviterLabel: `User ${inviter_user_id?.slice(-1)}`, inviterEmail: null };
  }),
  sendWorkspaceInviteEmail: vi.fn(
    async (a: { to: string; acceptUrl: string; inviterLabel: string; tenantName: string | null }) => {
      state.inviteEmailCalls.push({ email: a.to, acceptUrl: a.acceptUrl, inviterLabel: a.inviterLabel, tenantName: a.tenantName });
      if (state.inviteEmailThrows) {
        throw new Error("sendgrid send failed");
      }
      return { sent: true as const };
    },
  ),
}));

function mockRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = (code: number) => {
    res.statusCode = code;
    return res as Response;
  };
  res.json = (body: unknown) => {
    res.body = body;
    return res as Response;
  };
  res.send = (body?: unknown) => {
    res.body = body;
    return res as Response;
  };
  const headers: Record<string, unknown> = {};
  (res as unknown as { setHeader: (k: string, v: unknown) => void }).setHeader = (
    k: string,
    v: unknown,
  ) => {
    headers[k.toLowerCase()] = v;
  };
  (res as unknown as { getHeader: (k: string) => unknown }).getHeader = (k: string) =>
    headers[k.toLowerCase()];
  return res as Response & { statusCode?: number; body?: unknown };
}

import { membersRouter } from "@/routes/members";
import { INVITER_FALLBACK } from "@/email/templates/workspace-invite";

const router = membersRouter();

function dispatch(
  method: string,
  path: string,
  body: unknown = {},
): Promise<Response & { statusCode?: number; body?: unknown }> {
  return new Promise((resolve) => {
    const res = mockRes();
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve(res);
    };
    const origJson = res.json.bind(res);
    res.json = (b: unknown) => {
      const r = origJson(b);
      settle();
      return r;
    };
    const origSend = res.send.bind(res);
    res.send = (b?: unknown) => {
      const r = origSend(b);
      settle();
      return r;
    };
    const req = {
      method: method.toUpperCase(),
      url: path,
      body,
      headers: { authorization: "Bearer fake-jwt" },
      query: {},
      ip: "127.0.0.1",
    } as unknown as Request;
    (router as unknown as (req: Request, res: Response, next: () => void) => void)(
      req,
      res,
      () => {
        if (!res.statusCode) res.status(404);
        settle();
      },
    );
  });
}

beforeEach(() => {
  resetState();
  process.env.WEB_BASE_URL = "https://www.zaviagent.com";
});

describe("POST /v1/members/invite — direct-link flow", () => {
  it("happy path → 201 + invite_id, email sent with a DIRECT /invite/accept link (no /auth/callback)", async () => {
    const res = await dispatch("POST", "/invite", {
      email: "invitee@x.test",
      role: "member",
      agentSlugs: ["qa"],
    });

    expect(res.statusCode).toBe(201);
    expect((res.body as { invite_id?: string }).invite_id).toBe(inviteId);
    expect(state.rpcCalls.some((c) => c.name === "invite_member")).toBe(true);
    expect(state.inviteEmailCalls.length).toBe(1);
    expect(state.inviteEmailCalls[0].email).toBe("invitee@x.test");
    expect(state.inviteEmailCalls[0].acceptUrl).toBe(
      `https://www.zaviagent.com/invite/accept?id=${inviteId}&deeplink=invite`,
    );
    expect(state.inviteEmailCalls[0].acceptUrl).not.toContain("/auth/callback");
    expect(state.rpcCalls.some((c) => c.name === "revoke_invite")).toBe(false);
    expect(state.senderLookups).toEqual([{ tenant_id: t1, inviter_user_id: ownerId }]);
    expect(state.inviteEmailCalls[0]).toMatchObject({ inviterLabel: "User 1", tenantName: "Workspace 1" });
  });

  it("names the workspace the invite row joins, not the request's tenant", async () => {
    state.storedInvite = { tenant_id: t2, invited_by: ownerId };
    const res = await dispatch("POST", "/invite", { email: "invitee@x.test", role: "member" });
    expect(res.statusCode).toBe(201);
    expect(state.senderLookups).toEqual([{ tenant_id: t2, inviter_user_id: ownerId }]);
  });

  it("an unreadable invite row still sends, with no company and a generic inviter, and never revokes", async () => {
    state.storedInvite = null;
    const res = await dispatch("POST", "/invite", { email: "invitee@x.test", role: "member" });
    expect(res.statusCode).toBe(201);
    expect(state.senderLookups).toEqual([]);
    expect(state.inviteEmailCalls[0]).toMatchObject({ tenantName: null, inviterLabel: INVITER_FALLBACK });
    expect(state.rpcCalls.some((c) => c.name === "revoke_invite")).toBe(false);
  });

  it("names in the request body never reach the email", async () => {
    const res = await dispatch("POST", "/invite", {
      email: "invitee@x.test",
      role: "member",
      inviterLabel: "Your bank",
      tenantName: "Security team",
    });
    expect(res.statusCode).toBe(201);
    expect(state.inviteEmailCalls[0]).toMatchObject({ inviterLabel: "User 1", tenantName: "Workspace 1" });
  });

  it("existing or new invitee makes no difference — single direct-link path, no inviteUserByEmail branch", async () => {
    const res = await dispatch("POST", "/invite", {
      email: "ANY@x.test",
      role: "admin",
    });
    expect(res.statusCode).toBe(201);
    expect(state.inviteEmailCalls[0].email).toBe("any@x.test");
  });

  it("email send fails → revoke_invite + 502 (C7 atomicity)", async () => {
    state.inviteEmailThrows = true;
    const res = await dispatch("POST", "/invite", {
      email: "boom@x.test",
      role: "member",
      agentSlugs: ["qa"],
    });

    expect(res.statusCode).toBe(502);
    expect((res.body as { error?: { code?: string } }).error?.code).toBe("invite_email_failed");
    expect(state.inviteEmailCalls.length).toBe(1);
    const revoke = state.rpcCalls.find((c) => c.name === "revoke_invite");
    expect(revoke).toBeDefined();
    expect((revoke!.args as { p_invite_id?: string }).p_invite_id).toBe(inviteId);
  });
});

describe("POST /v1/members/accept — 42501 disambiguation", () => {
  const cases: Array<{ name: string; message: string; status: number; code: string }> = [
    { name: "already accepted → 409", message: "invite already accepted", status: 409, code: "already_accepted" },
    { name: "revoked → 410", message: "invite revoked", status: 410, code: "invite_revoked" },
    { name: "email mismatch → 403", message: "invite is for a different email", status: 403, code: "email_mismatch" },
    { name: "seat cap → 402 (never 403, which signs the user out)", message: "seat_cap_exceeded — tier free allows 1 seats", status: 402, code: "seat_cap_exceeded" },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      state.rpcReturns.accept_invite = { data: null, error: { code: "42501", message: c.message } };
      const res = await dispatch("POST", "/accept", { inviteId });
      expect(res.statusCode).toBe(c.status);
      expect((res.body as { error?: { code?: string } }).error?.code).toBe(c.code);
    });
  }

  it("invite not found (42704) → 404 via mapPgError fallback", async () => {
    state.rpcReturns.accept_invite = { data: null, error: { code: "42704", message: "invite x not found" } };
    const res = await dispatch("POST", "/accept", { inviteId });
    expect(res.statusCode).toBe(404);
  });

  it("success → 200 ok", async () => {
    state.rpcReturns.accept_invite = { data: null, error: null };
    const res = await dispatch("POST", "/accept", { inviteId });
    expect(res.statusCode).toBe(200);
    expect((res.body as { ok?: boolean }).ok).toBe(true);
  });
});

describe("POST /v1/members/invite/:id/resend", () => {
  it("pending invite → re-sends a DIRECT link to the STORED email, 200 + masked email", async () => {
    const id = "20000000-0000-0000-0000-0000000000a1";
    const inviter = "10000000-0000-0000-0000-000000000009";
    state.invite = { id, email: "Ravi@Gmail.com", accepted_at: null, revoked_at: null, tenant_id: t1, invited_by: inviter };
    const res = await dispatch("POST", `/invite/${id}/resend`);
    expect(res.statusCode).toBe(200);
    expect((res.body as { ok?: boolean }).ok).toBe(true);
    const masked = (res.body as { email_masked?: string }).email_masked ?? "";
    expect(masked).toBe("R***@G***.com");
    expect(masked).not.toContain("Ravi@Gmail.com");
    expect(state.inviteEmailCalls.length).toBe(1);
    expect(state.inviteEmailCalls[0].email).toBe("Ravi@Gmail.com");
    expect(state.inviteEmailCalls[0].acceptUrl).toBe(
      `https://www.zaviagent.com/invite/accept?id=${id}&deeplink=invite`,
    );
    expect(state.inviteEmailCalls[0].acceptUrl).not.toContain("/auth/callback");
    expect(state.senderLookups).toEqual([{ tenant_id: t1, inviter_user_id: inviter }]);
    expect(state.inviteEmailCalls[0]).toMatchObject({ inviterLabel: "User 9", tenantName: "Workspace 1" });
  });

  it("invalid invite id → 400, no email sent", async () => {
    const res = await dispatch("POST", "/invite/not-a-uuid/resend");
    expect(res.statusCode).toBe(400);
    expect(state.inviteEmailCalls.length).toBe(0);
  });

  it("unknown invite → 404, no email sent", async () => {
    const id = "20000000-0000-0000-0000-0000000000a3";
    state.invite = null;
    const res = await dispatch("POST", `/invite/${id}/resend`);
    expect(res.statusCode).toBe(404);
    expect(state.inviteEmailCalls.length).toBe(0);
  });

  it("revoked invite → 410, no email sent", async () => {
    const id = "20000000-0000-0000-0000-0000000000a4";
    state.invite = { id, email: "x@y.test", accepted_at: null, revoked_at: "2026-06-04T00:00:00Z" };
    const res = await dispatch("POST", `/invite/${id}/resend`);
    expect(res.statusCode).toBe(410);
    expect(state.inviteEmailCalls.length).toBe(0);
  });

  it("already-accepted invite → 409, no email sent", async () => {
    const id = "20000000-0000-0000-0000-0000000000a5";
    state.invite = { id, email: "x@y.test", accepted_at: "2026-06-04T00:00:00Z", revoked_at: null };
    const res = await dispatch("POST", `/invite/${id}/resend`);
    expect(res.statusCode).toBe(409);
    expect(state.inviteEmailCalls.length).toBe(0);
  });
});
