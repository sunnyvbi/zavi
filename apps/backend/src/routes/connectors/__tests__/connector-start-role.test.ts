import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request, Response } from "express";

const h = vi.hoisted(() => ({
  auth: { user_id: "user-1", tenant_id: "tenant-A", access_token: "jwt" } as Record<string, unknown>,
  roles: new Map<string, string>(),
  roleReadFails: false,
  rpcs: [] as string[],
  authorized: 0,
  exchanged: 0,
}));

vi.mock("@/services/connectors/core/connector-events", () => ({ recordConnectorEvent: vi.fn(async () => undefined) }));
vi.mock("@/services/tenants/founder-activity-alert", () => ({ notifyFounderActivity: vi.fn(async () => undefined) }));
vi.mock("@/services/tenants/active-tenant", () => ({ syncActiveTenant: vi.fn(async () => undefined) }));
vi.mock("@/services/connectors/core/token", () => ({ handleConnectorAccountSwap: vi.fn(async () => undefined) }));
vi.mock("@/services/secrets/vault", () => ({ getSecret: vi.fn(async () => null) }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: vi.fn(async () => ({ ...h.auth })) }));
vi.mock("@/services/supabase", () => {
  const client = {
    rpc: async (fn: string) => {
      h.rpcs.push(fn);
      return { data: [], error: null };
    },
    from: (table: string) => {
      const f: Record<string, unknown> = {};
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => ((f[c] = v), q),
        gt: () => q,
        maybeSingle: async () => {
          if (table !== "tenant_users") return { data: null, error: null };
          if (h.roleReadFails) return { data: null, error: { message: "timeout" } };
          const role = h.roles.get(`${f.tenant_id}:${f.user_id}`);
          return { data: role ? { role } : null, error: null };
        },
      };
      return q;
    },
  };
  return { serviceClient: () => client, serverClientFromBearer: () => client };
});
vi.mock("@/services/connectors/core/registry", () => {
  const connector = {
    slug: "linkedin_ads",
    serverId: "linkedin_ads",
    bindCallbackToSession: true,
    authorizeUrl: () => {
      h.authorized += 1;
      return "https://www.linkedin.com/oauth/v2/authorization?state=s";
    },
    exchangeCode: async () => {
      h.exchanged += 1;
      return { secrets: { access_token: "a" }, expiresInSec: 3600, metadata: { team_id: "x", team_name: "X", scopes: [] } };
    },
  };
  return {
    isKnownConnector: (slug: string) => slug === "linkedin_ads",
    getConnector: (slug: string) => (slug === "linkedin_ads" ? connector : null),
  };
});

import { connectorStart, connectorComplete } from "../connector";

process.env.BACKEND_PUBLIC_URL = "http://localhost:3011";

type Res = Response & { statusCode: number; body: any; location: string | null };
function mockRes(): Res {
  const res: Record<string, unknown> = { statusCode: 200, body: null, location: null };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: unknown) => ((res.body = b), res);
  res.redirect = (c: number, url: string) => ((res.statusCode = c), (res.location = url), res);
  return res as unknown as Res;
}
const startReq = () => ({ params: { connector: "linkedin_ads" }, query: {}, headers: { accept: "application/json" } }) as unknown as Request;
const completeReq = () => ({ params: { connector: "linkedin_ads" }, headers: {}, body: { code: "c", state: "s" } }) as unknown as Request;

beforeEach(() => {
  h.auth = { user_id: "user-1", tenant_id: "tenant-A", access_token: "jwt" };
  h.roles = new Map();
  h.roleReadFails = false;
  h.rpcs = [];
  h.authorized = 0;
  h.exchanged = 0;
});

describe("Connect or Reconnect LinkedIn Ads replaces the login every campaign uses, so only an owner or admin may start it", () => {
  it.each(["member", "viewer"])("a %s is refused before any sign-in is started", async (role) => {
    h.roles.set("tenant-A:user-1", role);
    const res = mockRes();
    await connectorStart(startReq(), res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe("connector_admin_only");
    expect(h.rpcs).not.toContain("mint_oauth_state");
    expect(h.authorized).toBe(0);
  });

  it("an owner of ANOTHER workspace who is only a member here is refused", async () => {
    h.roles.set("tenant-B:user-1", "owner");
    h.roles.set("tenant-A:user-1", "member");
    const res = mockRes();
    await connectorStart(startReq(), res);
    expect(res.statusCode).toBe(403);
    expect(h.rpcs).toEqual([]);
  });

  it("staff viewing the workspace are refused even with an owner role there", async () => {
    h.roles.set("tenant-A:user-1", "owner");
    h.auth = { ...h.auth, tenant_overridden: true };
    const res = mockRes();
    await connectorStart(startReq(), res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe("tenant_override_forbidden");
    expect(h.rpcs).toEqual([]);
    expect(h.authorized).toBe(0);
  });

  it("a role that cannot be read refuses with a try-again answer and starts nothing", async () => {
    h.roleReadFails = true;
    const res = mockRes();
    await connectorStart(startReq(), res);
    expect(res.statusCode).toBe(503);
    expect(res.body.error.message).toMatch(/Try again/);
    expect(h.rpcs).toEqual([]);
  });

  it.each(["owner", "admin"])("an %s starts the sign-in", async (role) => {
    h.roles.set("tenant-A:user-1", role);
    const res = mockRes();
    await connectorStart(startReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.oauth_url).toMatch(/^https:\/\/www\.linkedin\.com\//);
    expect(h.rpcs).toEqual(["mint_oauth_state"]);
  });

  it("a member who was demoted after an owner-started sign-in cannot finish it, and nothing is stored", async () => {
    h.roles.set("tenant-A:user-1", "member");
    const res = mockRes();
    await connectorComplete(completeReq(), res);
    expect(res.statusCode).toBe(403);
    expect(h.rpcs).toEqual([]);
    expect(h.exchanged).toBe(0);
  });

  it("staff view cannot finish a sign-in either", async () => {
    h.roles.set("tenant-A:user-1", "owner");
    h.auth = { ...h.auth, tenant_overridden: true };
    const res = mockRes();
    await connectorComplete(completeReq(), res);
    expect(res.statusCode).toBe(403);
    expect(h.rpcs).toEqual([]);
    expect(h.exchanged).toBe(0);
  });
});
