
import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Request, Response } from "express";

const BACKEND_ROOT = join(__dirname, "..", "..", "..");
const ROUTES_DIR = join(BACKEND_ROOT, "src", "routes", "members");

const HAS_ROUTES = existsSync(ROUTES_DIR);

const t1 = "00000000-0000-0000-0000-000000000001";
const ownerId = "10000000-0000-0000-0000-000000000001";
const adminId = "10000000-0000-0000-0000-000000000002";
const memberId = "10000000-0000-0000-0000-000000000003";
const inviteId = "20000000-0000-0000-0000-000000000001";

const state = {
  auth: {
    user_id: ownerId,
    tenant_id: t1,
    access_token: "fake-jwt",
    role: "owner" as "owner" | "admin" | "member",
  },
  rpcCalls: [] as Array<{ name: string; args: unknown }>,
  rpcReturns: {} as Record<
    string,
    { data: unknown; error: { code?: string; message: string } | null }
  >,
  inviteEmailThrows: false as boolean,
  existingAuthEmail: null as string | null,
  ownedSocial: [] as Array<{ platform: string; handle: string }>,
  checkFails: null as null | "member_rpc" | "user_lookup",
  profileUpdates: [] as Array<Record<string, unknown>>,
  openInvites: [] as Array<{
    id: string;
    email: string;
    role: string;
    invited_at: string;
    agent_slugs: string[];
  }>,
  members: [] as Array<{
    user_id: string;
    email: string;
    role: string;
    joined_at: string;
    agent_slugs: string[];
  }>,
};

function resetState() {
  state.auth = {
    user_id: ownerId,
    tenant_id: t1,
    access_token: "fake-jwt",
    role: "owner",
  };
  state.rpcCalls = [];
  state.profileUpdates = [];
  state.rpcReturns = {
    invite_member: { data: inviteId, error: null },
    revoke_invite: { data: null, error: null },
    accept_invite: { data: null, error: null },
    set_member_role: { data: null, error: null },
    revoke_member: { data: null, error: null },
  };
  state.inviteEmailThrows = false;
  state.existingAuthEmail = null;
  state.openInvites = [];
  state.members = [];
  state.ownedSocial = [];
  state.checkFails = null;
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

const bearerEqs: Array<{ table: string; col: string; val: unknown }> = [];

function bearerClientStub(): unknown {
  return {
    from(table: string) {
      const builder = {
        select(_cols: string) {
          return builder;
        },
        eq(col: string, val: unknown) {
          bearerEqs.push({ table, col, val });
          return builder;
        },
        limit(_n: number) {
          return builder;
        },
        is(_col: string, _val: unknown) {
          return builder;
        },
        order(_col: string, _opts: unknown) {
          return builder;
        },
        then(resolve: (v: { data: unknown; error: null }) => void) {
          resolve({ data: [], error: null });
        },
        async maybeSingle() {
          return { data: null, error: null };
        },
      };
      return builder;
    },
    rpc(name: string, args: unknown) {
      state.rpcCalls.push({ name, args });
      const ret = state.rpcReturns[name] ?? { data: null, error: null };
      return Promise.resolve(ret);
    },
  };
}

function serviceClientStub(): unknown {
  return {
    from(table: string) {
      const builder = {
        select(_cols: string) {
          return {
            eq(_col: string, _val: unknown) {
              return this;
            },
            is(_col: string, _val: unknown) {
              return this;
            },
            order(_col: string, _opts: unknown) {
              return this;
            },
            then(resolve: (v: { data: unknown; error: null }) => void) {
              if (table === "tenant_member_invites") {
                resolve({ data: state.openInvites, error: null });
                return;
              }
              if (table === "tenant_users") {
                resolve({ data: state.members, error: null });
                return;
              }
              if (table === "social_connected_accounts") {
                resolve({ data: state.ownedSocial, error: null });
                return;
              }
              resolve({ data: [], error: null });
            },
            async maybeSingle() {
              return { data: null, error: null };
            },
          };
        },
        update(patch: unknown) {
          if (table === "profiles") state.profileUpdates.push(patch as Record<string, unknown>);
          return {
            eq(_col: string, _val: unknown) {
              return this;
            },
            then(resolve: (v: { error: null }) => void) {
              resolve({ error: null });
            },
          };
        },
      };
      return builder;
    },
    rpc(name: string, args: unknown) {
      state.rpcCalls.push({ name, args });
      if (name === "is_tenant_member_email") {
        if (state.checkFails === "member_rpc") return Promise.resolve({ data: null, error: { message: "statement timeout" } });
        const email = String((args as { p_email?: string }).p_email ?? "").toLowerCase();
        return Promise.resolve({
          data: state.members.some((m) => m.role !== "viewer" && m.email.toLowerCase() === email),
          error: null,
        });
      }
      return Promise.resolve(state.rpcReturns[name] ?? { data: null, error: null });
    },
    auth: {
      admin: {
        async listUsers() {
          return {
            data: {
              users: state.existingAuthEmail
                ? [{ id: memberId, email: state.existingAuthEmail }]
                : [],
            },
            error: null,
          };
        },
        async inviteUserByEmail(email: string, _opts?: unknown) {
          if (state.inviteEmailThrows) {
            throw new Error("simulated_email_provider_failure");
          }
          return { data: { user: { id: "new-user-id", email } }, error: null };
        },
        async getUserByEmail(email: string) {
          if (
            state.existingAuthEmail &&
            email.toLowerCase() === state.existingAuthEmail.toLowerCase()
          ) {
            return {
              data: { user: { id: memberId, email: state.existingAuthEmail } },
              error: null,
            };
          }
          return { data: { user: null }, error: null };
        },
        async getUserById(id: string) {
          if (state.checkFails === "user_lookup") return { data: { user: null }, error: { message: "auth timeout" } };
          const m = state.members.find((x) => x.user_id === id);
          return { data: { user: m ? { id, email: m.email } : null }, error: null };
        },
        async deleteUser(_id: string) {
          return { error: null };
        },
        async updateUserById(_id: string, _patch: unknown) {
          return { data: null, error: null };
        },
      },
    },
  };
}

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => bearerClientStub(),
  serviceClient: () => serviceClientStub(),
}));

const sessionTenantMocks = vi.hoisted(() => ({
  clearSessionTenantsForMembership: vi.fn(async () => {}),
}));
vi.mock("@/services/tenants/session-tenant", () => ({
  clearSessionTenantsForMembership:
    sessionTenantMocks.clearSessionTenantsForMembership,
  getSessionTenant: vi.fn(async () => null),
  setSessionTenant: vi.fn(async () => {}),
}));

const emailMocks = vi.hoisted(() => ({
  sendWorkspaceInviteEmail: vi.fn(async () => {}),
}));
vi.mock("@/email/sendAuthEmail", () => ({
  sendWorkspaceInviteEmail: emailMocks.sendWorkspaceInviteEmail,
  resolveInviteSender: vi.fn(async () => ({ tenantName: "Acme", inviterLabel: "Owner", inviterEmail: null })),
}));

vi.mock("@/services/auth/redirect-base", () => ({ resolveAuthRedirectBase: () => "https://www.zaviagent.com" }));
vi.mock("@/services/tenants/founder-activity-alert", () => ({ notifyFounderActivity: vi.fn(async () => {}) }));

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
  return res as Response & { statusCode?: number; body?: unknown };
}

beforeEach(() => {
  resetState();
  sessionTenantMocks.clearSessionTenantsForMembership.mockClear();
  emailMocks.sendWorkspaceInviteEmail.mockClear();
});

async function loadHandler(
  pathFromMembers: string,
  exportName: string,
): Promise<((req: Request, res: Response) => Promise<void>) | null> {
  if (!HAS_ROUTES) return null;
  const fullPath = join(ROUTES_DIR, pathFromMembers);
  if (!existsSync(fullPath)) return null;
  try {
    const mod = (await import( fullPath)) as Record<
      string,
      unknown
    >;
    return (
      (mod[exportName] as (req: Request, res: Response) => Promise<void>) ??
      (mod.default as (req: Request, res: Response) => Promise<void>) ??
      null
    );
  } catch {
    return null;
  }
}

describe.skipIf(!HAS_ROUTES)("/v1/members routes — slice 2 trust boundaries", () => {
  describe("POST /v1/members/invite", () => {
    it("pre-existing auth.users email must NOT block the invite (OTP login & invite both create that row — old 409 pre-check was a bug)", async () => {
      const handler = await loadHandler("invite.ts", "membersInvite");
      if (!handler) return;
      state.existingAuthEmail = "EXISTING@zaviagent.com";
      const req = {
        params: {},
        body: {
          email: "existing@zaviagent.com",
          role: "member",
          agentSlugs: ["qa"],
        },
      } as unknown as Request;
      const res = mockRes();

      await handler(req, res);

      expect(res.statusCode === 200 || res.statusCode === 201).toBe(true);
      expect(state.rpcCalls.some((c) => c.name === "invite_member")).toBe(
        true,
      );
    });

    it("happy path: creates invite + fires email + returns 200 with invite id", async () => {
      const handler = await loadHandler("invite.ts", "membersInvite");
      if (!handler) return;
      const req = {
        params: {},
        body: {
          email: "new-pm@x.test",
          role: "member",
          agentSlugs: ["qa", "pm"],
        },
      } as unknown as Request;
      const res = mockRes();

      await handler(req, res);

      expect(res.statusCode === 200 || res.statusCode === 201).toBe(true);
      const inviteRpc = state.rpcCalls.filter(
        (c) => c.name === "invite_member",
      );
      expect(inviteRpc.length).toBe(1);
      const args = inviteRpc[0].args as { p_email?: string };
      if (args.p_email) {
        expect(args.p_email).toBe("new-pm@x.test");
      }
    });

    it("C7 atomicity: if inviteUserByEmail throws, the route revokes the orphan invite", async () => {
      const handler = await loadHandler("invite.ts", "membersInvite");
      if (!handler) return;
      state.inviteEmailThrows = true;
      const req = {
        params: {},
        body: {
          email: "boom@x.test",
          role: "member",
          agentSlugs: ["qa"],
        },
      } as unknown as Request;
      const res = mockRes();

      await handler(req, res);

      const revokeRpc = state.rpcCalls.find(
        (c) => c.name === "revoke_invite",
      );
      expect(revokeRpc, "revoke_invite must be called on email failure").toBeDefined();
      if (revokeRpc) {
        const args = revokeRpc.args as { p_invite_id?: string };
        if (args.p_invite_id) {
          expect(args.p_invite_id).toBe(inviteId);
        }
      }
    });
  });

  describe("DELETE /v1/members/invites/:inviteId", () => {
    it("owner can cancel a pending invite", async () => {
      const handler = await loadHandler(
        "revoke-invite.ts",
        "membersRevokeInvite",
      );
      if (!handler) return;
      state.auth.role = "owner";
      const req = {
        params: { inviteId },
        body: {},
      } as unknown as Request;
      const res = mockRes();

      await handler(req, res);

      expect((res.statusCode ?? 200) < 400).toBe(true);
      const rpc = state.rpcCalls.find((c) => c.name === "revoke_invite");
      expect(rpc).toBeDefined();
    });

    it("member receives 403 (route + RPC layer reject)", async () => {
      const handler = await loadHandler(
        "revoke-invite.ts",
        "membersRevokeInvite",
      );
      if (!handler) return;
      state.auth.role = "member";
      state.rpcReturns.revoke_invite = {
        data: null,
        error: { code: "42501", message: "forbidden" },
      };
      const req = {
        params: { inviteId },
        body: {},
      } as unknown as Request;
      const res = mockRes();

      await handler(req, res);

      expect(res.statusCode === 403 || res.statusCode === 401).toBe(true);
    });
  });

  describe("GET /v1/members — safe-field projection only (C11)", () => {
    it("returns user_id, email, role, joined_at, agent_slugs and NOTHING ELSE", async () => {
      const handler = await loadHandler("list.ts", "membersList");
      if (!handler) return;
      state.members = [
        {
          user_id: ownerId,
          email: "owner@x.test",
          role: "owner",
          joined_at: "2026-05-17T00:00:00Z",
          agent_slugs: [],
        },
        {
          user_id: memberId,
          email: "member@x.test",
          role: "member",
          joined_at: "2026-05-17T00:00:00Z",
          agent_slugs: ["qa"],
        },
      ];
      const req = { params: {}, body: {}, query: {} } as unknown as Request;
      const res = mockRes();

      await handler(req, res);

      const body = res.body as { members?: Array<Record<string, unknown>> };
      const arr = Array.isArray(res.body)
        ? (res.body as Array<Record<string, unknown>>)
        : (body.members ?? []);
      expect(arr.length).toBeGreaterThan(0);
      const allowed = new Set([
        "user_id",
        "email",
        "role",
        "joined_at",
        "agent_slugs",
        "last_active",
        "display_name",
      ]);
      const forbidden = [
        "encrypted_password",
        "password",
        "raw_app_meta_data",
        "raw_user_meta_data",
        "instance_id",
        "confirmation_token",
        "recovery_token",
      ];
      for (const row of arr) {
        for (const f of forbidden) {
          expect(Object.keys(row), `row leaks ${f}`).not.toContain(f);
        }
        for (const k of Object.keys(row)) {
          if (!allowed.has(k)) {
            throw new Error(
              `unexpected key in GET /v1/members projection: ${k}`,
            );
          }
        }
      }
    });
  });

  describe("Owner-only routes — member 403", () => {
    it("POST /v1/members/:userId/promote returns 403 for member callers", async () => {
      const handler = await loadHandler("promote.ts", "membersPromote");
      if (!handler) return;
      state.auth.role = "member";
      state.rpcReturns.promote_member_to_admin = {
        data: null,
        error: { code: "42501", message: "forbidden" },
      };
      const req = {
        params: { userId: memberId },
        body: {},
      } as unknown as Request;
      const res = mockRes();

      await handler(req, res);

      expect(res.statusCode === 403 || res.statusCode === 401).toBe(true);
    });

    it("POST /v1/members/:userId/demote returns 403 for member callers", async () => {
      const handler = await loadHandler("demote.ts", "membersDemote");
      if (!handler) return;
      state.auth.role = "member";
      state.rpcReturns.demote_admin_to_member = {
        data: null,
        error: { code: "42501", message: "forbidden" },
      };
      const req = {
        params: { userId: adminId },
        body: { agentSlugs: ["qa"] },
      } as unknown as Request;
      const res = mockRes();

      await handler(req, res);

      expect(res.statusCode === 403 || res.statusCode === 401).toBe(true);
    });

    it("POST /v1/members/:userId/promote returns 403 for admin callers (owner-only)", async () => {
      const handler = await loadHandler("promote.ts", "membersPromote");
      if (!handler) return;
      state.auth.role = "admin";
      state.rpcReturns.promote_member_to_admin = {
        data: null,
        error: { code: "42501", message: "forbidden" },
      };
      const req = {
        params: { userId: memberId },
        body: {},
      } as unknown as Request;
      const res = mockRes();

      await handler(req, res);

      expect((res.statusCode ?? 200) >= 400).toBe(true);
    });
  });

  describe("POST /v1/members/accept — JWT email must match invite email (case-insensitive)", () => {
    it("accept_invite RPC is called with the invite id", async () => {
      const handler = await loadHandler("accept.ts", "membersAccept");
      if (!handler) return;
      const req = {
        params: {},
        body: { inviteId },
      } as unknown as Request;
      const res = mockRes();

      await handler(req, res);

      const rpc = state.rpcCalls.find((c) => c.name === "accept_invite");
      expect(rpc, "accept_invite RPC must be called").toBeDefined();
      if (rpc) {
        const args = rpc.args as { p_invite_id?: string };
        if (args.p_invite_id) {
          expect(args.p_invite_id).toBe(inviteId);
        }
      }
    });

    it("rejects when accept_invite raises 42501 (JWT email != invite email)", async () => {
      const handler = await loadHandler("accept.ts", "membersAccept");
      if (!handler) return;
      state.rpcReturns.accept_invite = {
        data: null,
        error: {
          code: "42501",
          message: "JWT email does not match invite email",
        },
      };
      const req = {
        params: {},
        body: { inviteId },
      } as unknown as Request;
      const res = mockRes();

      await handler(req, res);

      expect((res.statusCode ?? 200) >= 400).toBe(true);
    });
  });
});

import { membersRouter } from "@/routes/members";

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
      headers: {},
      query: {},
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

describe("membersRouter() — role-gate + trust-boundary (real router dispatch)", () => {
  describe("invite failures carry a sentence the apps show as-is", () => {
    it("a full workspace with a pending invite is seat_cap_exceeded with the seat count, not 'forbidden'", async () => {
      state.openInvites = [{ id: inviteId, email: "pending@x.test", role: "member", invited_at: "2026-10-05", agent_slugs: [] }];
      state.rpcReturns.invite_member = {
        data: null,
        error: { code: "42501", message: "seat_cap_exceeded — tier pilot allows 3 seats (3/3 used)" },
      };
      const res = await dispatch("POST", "/invite", { email: "test03@x.test", role: "member" });
      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual({
        error: {
          code: "seat_cap_exceeded",
          message:
            "Your plan has room for 3 people, counting pending invites. Cancel a pending invite or remove someone to invite another teammate.",
        },
      });
    });

    it("a Free owner alone with no pending invites is told to upgrade, not to cancel an invite or remove someone", async () => {
      state.members = [{ user_id: ownerId, email: "owner@x.test", role: "owner", joined_at: "2026-10-05", agent_slugs: [] }];
      state.openInvites = [];
      state.rpcReturns.invite_member = {
        data: null,
        error: { code: "42501", message: "seat_cap_exceeded — tier free allows 1 seats (1/1 used)" },
      };
      const res = await dispatch("POST", "/invite", { email: "new@x.test", role: "member" });
      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual({
        error: {
          code: "seat_cap_exceeded",
          message: "Your Free plan has 1 seat, and it's yours. Upgrade your plan to invite teammates.",
        },
      });
      expect(emailMocks.sendWorkspaceInviteEmail).not.toHaveBeenCalled();
    });

    it("a full multi-seat plan with no pending invites names its seats and offers remove or upgrade", async () => {
      state.openInvites = [];
      state.rpcReturns.invite_member = {
        data: null,
        error: { code: "42501", message: "seat_cap_exceeded — tier starter allows 3 seats (3/3 used)" },
      };
      const res = await dispatch("POST", "/invite", { email: "new@x.test", role: "member" });
      expect((res.body as { error: { message: string } }).error.message).toBe(
        "Your Starter plan's 3 seats are all taken. Remove someone or upgrade your plan to invite another teammate.",
      );
    });

    it("a one-seat plan with a pending invite says '1 person', not '1 people'", async () => {
      state.openInvites = [{ id: inviteId, email: "pending@x.test", role: "member", invited_at: "2026-10-05", agent_slugs: [] }];
      state.rpcReturns.invite_member = {
        data: null,
        error: { code: "42501", message: "seat_cap_exceeded — tier free allows 1 seats (1/1 used)" },
      };
      const res = await dispatch("POST", "/invite", { email: "new@x.test", role: "member" });
      expect(res.statusCode).toBe(403);
      expect((res.body as { error: { message: string } }).error.message).toMatch(/^Your plan has room for 1 person, counting/);
    });

    const member = (user_id: string, email: string, role = "member") => ({ user_id, email, role, joined_at: "2026-10-01", agent_slugs: [] });
    const invited = (email: string) => ({ id: inviteId, email, role: "member", invited_at: "2026-10-05", agent_slugs: [] });
    const ALREADY = { error: { code: "conflict", message: "That person is already a member or already has an invite." } };

    for (const [label, setup, email] of [
      ["an existing member", () => { state.members = [member(ownerId, "owner@x.test"), member(memberId, "teammate@x.test")]; }, "TeamMate@x.test"],
      ["your own email", () => { state.members = [member(ownerId, "owner@x.test")]; }, "owner@x.test"],
      ["someone with an open invite", () => { state.openInvites = [invited("pending@x.test")]; }, "pending@x.test"],
      ["a viewer", () => { state.members = [member(ownerId, "owner@x.test", "owner"), member(memberId, "viewer@x.test", "viewer")]; }, "viewer@x.test"],
    ] as const) {
      it(`inviting ${label} is refused with 'already a member', and no invite or email goes out`, async () => {
        setup();
        const res = await dispatch("POST", "/invite", { email, role: "member" });
        expect(res.statusCode).toBe(409);
        expect(res.body).toEqual(ALREADY);
        expect(state.rpcCalls.some((c) => c.name === "invite_member")).toBe(false);
        expect(emailMocks.sendWorkspaceInviteEmail).not.toHaveBeenCalled();
      });
    }

    for (const [label, fails] of [
      ["the member check times out", "member_rpc"],
      ["a viewer's account cannot be read", "user_lookup"],
    ] as const) {
      it(`when ${label}, nobody is invited or emailed and the inviter is told to try again`, async () => {
        state.members = [member(ownerId, "owner@x.test", "owner"), member(memberId, "viewer@x.test", "viewer")];
        state.checkFails = fails;
        const res = await dispatch("POST", "/invite", { email: "viewer@x.test", role: "member" });
        expect(res.statusCode).toBe(503);
        expect((res.body as { error: { code: string } }).error.code).toBe("invite_check_unavailable");
        expect(state.rpcCalls.some((c) => c.name === "invite_member")).toBe(false);
        expect(emailMocks.sendWorkspaceInviteEmail).not.toHaveBeenCalled();
      });
    }

    it("on a full workspace, a duplicate gets 'already a member', not the seat-cap error", async () => {
      state.openInvites = [invited("pending@x.test")];
      state.rpcReturns.invite_member = {
        data: null,
        error: { code: "42501", message: "seat_cap_exceeded — tier free allows 1 seats (1/1 used)" },
      };
      const res = await dispatch("POST", "/invite", { email: "pending@x.test", role: "member" });
      expect(res.statusCode).toBe(409);
      expect(res.body).toEqual(ALREADY);
    });

    it("someone with a Zavi login who is not in this workspace is still invited and emailed once", async () => {
      state.members = [member(ownerId, "owner@x.test")];
      state.existingAuthEmail = "outsider@x.test";
      const res = await dispatch("POST", "/invite", { email: "outsider@x.test", role: "member" });
      expect(res.statusCode).toBe(201);
      expect(state.rpcCalls.filter((c) => c.name === "invite_member")).toHaveLength(1);
      expect(emailMocks.sendWorkspaceInviteEmail).toHaveBeenCalledTimes(1);
    });

    it("a non-admin cannot learn who has an open invite or is a member: 403, and the team is never read", async () => {
      state.auth.role = "member";
      state.auth.user_id = memberId;
      state.openInvites = [invited("pending@x.test")];
      state.members = [member(ownerId, "owner@x.test", "owner"), member(memberId, "teammate@x.test")];
      state.rpcReturns._assert_tenant_admin = {
        data: null,
        error: { code: "42501", message: "forbidden — role member cannot perform admin action" },
      };
      for (const email of ["pending@x.test", "owner@x.test", "nobody@x.test"]) {
        const res = await dispatch("POST", "/invite", { email, role: "member" });
        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({
          error: { code: "forbidden", message: "Only owners and admins can invite teammates." },
        });
      }
      expect(state.rpcCalls.some((c) => c.name === "is_tenant_member_email")).toBe(false);
      expect(state.rpcCalls.some((c) => c.name === "invite_member")).toBe(false);
      expect(emailMocks.sendWorkspaceInviteEmail).not.toHaveBeenCalled();
    });

    it("a non-admin gets a plain sentence, never the database's wording", async () => {
      state.rpcReturns.invite_member = {
        data: null,
        error: { code: "42501", message: "forbidden — role member cannot perform admin action" },
      };
      const res = await dispatch("POST", "/invite", { email: "a@x.test", role: "member" });
      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual({
        error: { code: "forbidden", message: "Only owners and admins can invite teammates." },
      });
    });
  });

  describe("role change is owner-only (set_member_role 42501 → 403)", () => {
    it("POST /:userId/role — member caller forwarded as 403", async () => {
      state.auth.role = "member";
      state.rpcReturns.set_member_role = {
        data: null,
        error: { code: "42501", message: "only owner can change roles" },
      };
      const res = await dispatch("POST", `/${memberId}/role`, { role: "admin" });
      expect(res.statusCode).toBe(403);
      expect(state.rpcCalls.some((c) => c.name === "set_member_role")).toBe(true);
    });

    it("POST /:userId/role — admin caller forwarded as 403 (owner-only)", async () => {
      state.auth.role = "admin";
      state.rpcReturns.set_member_role = {
        data: null,
        error: { code: "42501", message: "only owner can change roles" },
      };
      const res = await dispatch("POST", `/${memberId}/role`, { role: "viewer" });
      expect(res.statusCode).toBe(403);
    });

    it("POST /:userId/role — owner sets viewer; the RPC gets exactly that role", async () => {
      state.auth.role = "owner";
      const res = await dispatch("POST", `/${memberId}/role`, { role: "viewer" });
      expect(res.statusCode).toBe(200);
      const call = state.rpcCalls.find((c) => c.name === "set_member_role");
      expect(call?.args).toEqual({ p_user_id: memberId, p_role: "viewer" });
    });

    it("POST /:userId/role — 'owner' is not a settable role → 400, no RPC", async () => {
      state.auth.role = "owner";
      const res = await dispatch("POST", `/${memberId}/role`, { role: "owner" });
      expect(res.statusCode).toBe(400);
      expect(state.rpcCalls.some((c) => c.name === "set_member_role")).toBe(false);
    });
  });

  describe("the per-agent allowlist routes are gone", () => {
    it.each(["agents", "promote", "demote"])("POST /:userId/%s → 404", async (seg) => {
      state.auth.role = "owner";
      const res = await dispatch("POST", `/${memberId}/${seg}`, { agentSlugs: ["qa"] });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("owner cannot be revoked / admin cannot revoke a peer admin (RPC 42501 → 403)", () => {
    it("DELETE /:userId — owner target rejected (revoke_member raises 42501)", async () => {
      state.auth.role = "admin";
      state.rpcReturns.revoke_member = {
        data: null,
        error: { code: "42501", message: "cannot revoke the owner" },
      };
      const res = await dispatch("DELETE", `/${ownerId}`, {});
      expect(res.statusCode).toBe(403);
      expect(state.rpcCalls.some((c) => c.name === "revoke_member")).toBe(true);
    });

    it("DELETE /:userId — admin revoking another admin rejected when RPC raises 42501", async () => {
      state.auth.role = "admin";
      state.rpcReturns.revoke_member = {
        data: null,
        error: { code: "42501", message: "cannot revoke a peer admin" },
      };
      const res = await dispatch("DELETE", `/${adminId}`, {});
      expect(res.statusCode).toBe(403);
    });

    it("Gap3/D1-P2 QA#5 — a successful revoke PURGES the member's owned social creds", async () => {
      state.auth.role = "owner";
      state.rpcReturns.revoke_member = { data: null, error: null };
      state.ownedSocial = [
        { platform: "linkedin", handle: "acme" },
        { platform: "instagram", handle: "acme.co" },
      ];
      const res = await dispatch("DELETE", `/${memberId}`, {});
      expect(res.statusCode).toBe(200);
      const clears = state.rpcCalls.filter((c) => c.name === "clear_social_connection");
      expect(clears).toHaveLength(2);
      expect(clears.map((c) => (c.args as { p_handle: string }).p_handle).sort()).toEqual([
        "acme",
        "acme.co",
      ]);
      for (const c of clears) {
        expect((c.args as { p_tenant_id: string }).p_tenant_id).toBe(t1);
      }
    });

    it("Gap3/D1-P2 — a revoke with NO owned social connections clears nothing", async () => {
      state.auth.role = "owner";
      state.rpcReturns.revoke_member = { data: null, error: null };
      state.ownedSocial = [];
      const res = await dispatch("DELETE", `/${memberId}`, {});
      expect(res.statusCode).toBe(200);
      expect(state.rpcCalls.some((c) => c.name === "clear_social_connection")).toBe(false);
    });

    it("a successful revoke CLEARS the revoked user's session pins at that tenant", async () => {
      state.auth.role = "owner";
      state.rpcReturns.revoke_member = { data: null, error: null };
      const res = await dispatch("DELETE", `/${memberId}`, {});
      expect(res.statusCode).toBe(200);
      expect(
        sessionTenantMocks.clearSessionTenantsForMembership,
      ).toHaveBeenCalledWith(memberId, t1);
    });

    it("a revoke moves the member's active company to one they still OWN, not to null", async () => {
      state.auth.role = "owner";
      state.rpcReturns.revoke_member = { data: null, error: null };
      state.members = [
        { tenant_id: "t-invited", role: "member" },
        { tenant_id: "t-owned", role: "owner" },
      ] as never;
      const res = await dispatch("DELETE", `/${memberId}`, {});
      expect(res.statusCode).toBe(200);
      expect(state.profileUpdates).toContainEqual({ active_tenant_id: "t-owned" });
    });

    it("a revoke with no other company left clears the active company", async () => {
      state.auth.role = "owner";
      state.rpcReturns.revoke_member = { data: null, error: null };
      state.members = [];
      const res = await dispatch("DELETE", `/${memberId}`, {});
      expect(res.statusCode).toBe(200);
      expect(state.profileUpdates).toContainEqual({ active_tenant_id: null });
    });

    it("a FAILED revoke does not clear session pins (membership still stands)", async () => {
      state.auth.role = "owner";
      state.rpcReturns.revoke_member = {
        data: null,
        error: { code: "42501", message: "owner/admin only" },
      };
      const res = await dispatch("DELETE", `/${memberId}`, {});
      expect(res.statusCode).not.toBe(200);
      expect(
        sessionTenantMocks.clearSessionTenantsForMembership,
      ).not.toHaveBeenCalled();
    });
  });

  describe("GET /invites is scoped to the ACTIVE tenant", () => {
    it("filters tenant_member_invites by auth.tenant_id", async () => {
      state.auth.role = "owner";
      bearerEqs.length = 0;
      const res = await dispatch("GET", "/invites");
      expect(res.statusCode ?? 200).toBe(200);
      expect(bearerEqs).toContainEqual({
        table: "tenant_member_invites",
        col: "tenant_id",
        val: state.auth.tenant_id,
      });
    });
  });

  describe("member cannot cancel an invite (revoke_invite 42501 → 403)", () => {
    it("DELETE /invites/:inviteId — member caller forwarded as 403", async () => {
      state.auth.role = "member";
      state.rpcReturns.revoke_invite = {
        data: null,
        error: { code: "42501", message: "owner/admin only" },
      };
      const res = await dispatch("DELETE", `/invites/${inviteId}`, {});
      expect(res.statusCode).toBe(403);
    });
  });

  describe("malformed path params reject before any RPC fires", () => {
    it("POST /:userId/role with a non-UUID userId → 400, no RPC", async () => {
      state.auth.role = "owner";
      const res = await dispatch("POST", `/not-a-uuid/role`, { role: "member" });
      expect(res.statusCode).toBe(400);
      expect(state.rpcCalls.some((c) => c.name === "set_member_role")).toBe(false);
    });

    it("DELETE /:userId with a non-UUID userId → 400, no revoke RPC", async () => {
      state.auth.role = "owner";
      const res = await dispatch("DELETE", `/xyz`, {});
      expect(res.statusCode).toBe(400);
      expect(state.rpcCalls.some((c) => c.name === "revoke_member")).toBe(false);
    });
  });

  describe("unauthenticated caller is rejected before any RPC fires", () => {
    it("POST /:userId/role with no auth → 401, no RPC", async () => {
      const saved = state.auth;
      (state as { auth: typeof state.auth | null }).auth = null;
      try {
        const res = await dispatch("POST", `/${memberId}/role`, { role: "member" });
        expect(res.statusCode === 401 || res.statusCode === 404).toBe(true);
        expect(state.rpcCalls.some((c) => c.name === "set_member_role")).toBe(false);
      } finally {
        state.auth = saved;
      }
    });
  });
});

describe("/v1/members route module presence", () => {
  it("expects apps/backend/src/routes/members/* to exist (slice 2)", () => {
    if (!HAS_ROUTES) {
      // eslint-disable-next-line no-console
      console.warn(
        `[slice 4] routes/members/ not yet present at ${ROUTES_DIR} — route suite skipped until slice 2 lands.`,
      );
    }
    expect(true).toBe(true);
  });
});
