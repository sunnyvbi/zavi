import { describe, it, expect, beforeEach, vi } from "vitest";
import crypto from "node:crypto";
import type { Request, Response } from "express";

const h = vi.hoisted(() => ({
  roleFor: vi.fn(async (..._a: unknown[]): Promise<string | null> => "owner"),
  states: new Map<string, { tenant_id: string; user_id: string }>(),
  authorizeStates: [] as string[],
  exchangeStates: [] as string[],
  upserts: [] as unknown[],
}));

vi.mock("@/services/connectors/core/connector-events", () => ({ recordConnectorEvent: vi.fn(async () => undefined) }));
vi.mock("@/services/tenants/founder-activity-alert", () => ({ notifyFounderActivity: vi.fn(async () => undefined) }));
vi.mock("@/services/tenants/active-tenant", () => ({ syncActiveTenant: vi.fn(async () => undefined) }));
vi.mock("@/services/connectors/core/token", () => ({ handleConnectorAccountSwap: vi.fn(async () => undefined) }));
vi.mock("@/services/secrets/vault", () => ({ getSecret: vi.fn(async () => null) }));
vi.mock("@/services/auth/tenant-role", () => ({ loadTenantRole: vi.fn(async () => "owner"), loadTenantRoleFor: (...a: unknown[]) => h.roleFor(...a) }));
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ user_id: "user-A", tenant_id: "t1", access_token: "jwt" })),
}));
vi.mock("@/services/supabase", () => {
  const client = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "mint_oauth_state") {
        h.states.set(`${args.p_provider}:${args.p_state_hash}`, {
          tenant_id: String(args.p_tenant_id),
          user_id: String(args.p_user_id),
        });
        return { data: null, error: null };
      }
      if (fn === "consume_oauth_state") {
        const key = `${args.p_provider}:${args.p_state_hash}`;
        const row = h.states.get(key);
        h.states.delete(key);
        return { data: row ? [row] : [], error: null };
      }
      if (fn === "set_connector_connection") {
        h.upserts.push(args);
        return { data: null, error: null };
      }
      return { data: null, error: null };
    },
    from: () => {
      const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: null, error: null }) };
      return q;
    },
  };
  return { serviceClient: () => client, serverClientFromBearer: () => client };
});
vi.mock("@/services/connectors/core/registry", () => {
  const connector = {
    slug: "linkedin_ads",
    serverId: "linkedin_ads",
    authorizeUrl: (state: string, redirect: string) => {
      h.authorizeStates.push(state);
      return `https://www.linkedin.com/oauth/v2/authorization?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirect)}`;
    },
    exchangeCode: async (_code: string, _redirect: string, state: string) => {
      h.exchangeStates.push(state);
      return { secrets: { access_token: "a" }, expiresInSec: 3600, metadata: { team_id: "acct-1", team_name: "Acme", scopes: [] } };
    },
  };
  return {
    isKnownConnector: (slug: string) => slug === "linkedin_ads" || slug === "linear",
    getConnector: (slug: string) => (slug === "linkedin_ads" || slug === "linear" ? { ...connector, slug, serverId: slug } : null),
  };
});

import { connectorStart, connectorCallback, safeReturnPath } from "../connector";

process.env.BACKEND_PUBLIC_URL = "http://localhost:3011";
process.env.WEB_ORIGIN = "http://localhost:3040";

type Res = Response & { statusCode: number; body: any; location: string | null };
function mockRes(): Res {
  const res: Record<string, unknown> = { statusCode: 200, body: null, location: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.redirect = (c: number, url: string) => { res.statusCode = c; res.location = url; return res; };
  return res as unknown as Res;
}

async function connectFrom(slug: string, returnTo: string | undefined): Promise<Res> {
  const startRes = mockRes();
  await connectorStart(
    {
      params: { connector: slug },
      query: returnTo === undefined ? {} : { return_to: returnTo },
      headers: { accept: "application/json", authorization: "Bearer jwt" },
    } as unknown as Request,
    startRes,
  );
  expect(startRes.statusCode).toBe(200);
  const state = new URL(startRes.body.oauth_url).searchParams.get("state")!;
  const cbRes = mockRes();
  await connectorCallback(
    { params: { connector: slug }, query: { code: "c-1", state }, headers: {} } as unknown as Request,
    cbRes,
  );
  return cbRes;
}

beforeEach(() => {
  h.states.clear();
  h.authorizeStates.length = 0;
  h.exchangeStates.length = 0;
  h.upserts.length = 0;
});

describe("connector OAuth return path", () => {
  it("sends the founder back to the exact LinkedIn Ads channel page they connected from, with the connected flag", async () => {
    const res = await connectFrom("linkedin_ads", "/workspace?tab=channels&channel=linkedin_ads");
    expect(res.statusCode).toBe(302);
    expect(res.location).toBe("http://localhost:3040/workspace?tab=channels&channel=linkedin_ads&linkedin_ads=connected");
    expect(h.upserts).toHaveLength(1);
    expect(h.exchangeStates[0]).toBe(h.authorizeStates[0]);
  });

  it("keeps a thread path and hash intact", async () => {
    const res = await connectFrom("linkedin_ads", "/workspace/0b6d4c1e-1111-4222-8333-944455556666?agent=operator#x");
    expect(res.location).toBe(
      "http://localhost:3040/workspace/0b6d4c1e-1111-4222-8333-944455556666?agent=operator&linkedin_ads=connected#x",
    );
  });

  it.each([
    "https://evil.com",
    "//evil.com",
    "/\\evil.com",
    "/\tevil.com",
    "/\t/evil.com",
    "https://evil.com/workspace?tab=channels",
    "/workspace/../../evil",
    "/login?next=https://evil.com",
    "/workspacex",
    "/workspace?tab=settings",
    "javascript:alert(1)",
  ])("ignores the unsafe return path %j and lands on the old Settings default", async (bad) => {
    const res = await connectFrom("linkedin_ads", bad);
    expect(res.statusCode).toBe(302);
    expect(res.location).toBe("http://localhost:3040/workspace?tab=settings&linkedin_ads=connected");
  });

  it("leaves a connector started without a return path on the unchanged default, with an unchanged plain state", async () => {
    const res = await connectFrom("linear", undefined);
    expect(res.location).toBe("http://localhost:3040/workspace?tab=settings&linear=connected");
    expect(h.authorizeStates[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("refuses a callback whose state had its return path swapped after minting", async () => {
    const startRes = mockRes();
    await connectorStart(
      {
        params: { connector: "linkedin_ads" },
        query: { return_to: "/workspace?tab=channels&channel=linkedin_ads" },
        headers: { accept: "application/json" },
      } as unknown as Request,
      startRes,
    );
    const state = new URL(startRes.body.oauth_url).searchParams.get("state")!;
    const forged = `${state.split(".")[0]}.${Buffer.from("/workspace?tab=channels&channel=meta_ads").toString("base64url")}`;
    const cbRes = mockRes();
    await connectorCallback(
      { params: { connector: "linkedin_ads" }, query: { code: "c", state: forged }, headers: {} } as unknown as Request,
      cbRes,
    );
    expect(cbRes.statusCode).toBe(302);
    expect(new URL(cbRes.location!).searchParams.get("connect_error")).toBe("permission_denied");
    expect(cbRes.location).not.toContain("meta_ads");
    expect(h.upserts).toHaveLength(0);
    expect(crypto.createHash("sha256").update(forged).digest("hex")).not.toBe(
      crypto.createHash("sha256").update(state).digest("hex"),
    );
  });

  it.each([
    ["was demoted to member", async () => "member"],
    ["left the workspace", async () => null],
    ["cannot be checked", async () => { throw new Error("down"); }],
  ])("saves nothing when the person who started the connect %s before the callback", async (_label, role) => {
    const startRes = mockRes();
    await connectorStart(
      { params: { connector: "linkedin_ads" }, query: {}, headers: { accept: "application/json" } } as unknown as Request,
      startRes,
    );
    const state = new URL(startRes.body.oauth_url).searchParams.get("state")!;
    h.roleFor.mockImplementationOnce(role);
    const cbRes = mockRes();
    await connectorCallback(
      { params: { connector: "linkedin_ads" }, query: { code: "c", state }, headers: {} } as unknown as Request,
      cbRes,
    );
    expect(cbRes.statusCode).toBe(302);
    expect(new URL(cbRes.location!).searchParams.get("connect_error")).toBe("permission_denied");
    expect(h.upserts).toHaveLength(0);
    expect(h.exchangeStates).toHaveLength(0);
  });

  it("safeReturnPath accepts only same-origin workspace pages", () => {
    expect(safeReturnPath("/workspace?tab=channels&channel=linkedin_ads")).toBe("/workspace?tab=channels&channel=linkedin_ads");
    expect(safeReturnPath("//evil.com/workspace")).toBeNull();
    expect(safeReturnPath(["/workspace"])).toBeNull();
    expect(safeReturnPath(`/workspace?x=${"a".repeat(600)}`)).toBeNull();
    const expands = `/workspace?x=${"é".repeat(200)}`;
    expect(expands.length).toBeLessThanOrEqual(512);
    expect(safeReturnPath(expands)).toBeNull();
    const fits = `/workspace?x=${"é".repeat(80)}`;
    expect(safeReturnPath(fits)).toBe(`/workspace?x=${"%C3%A9".repeat(80)}`);
  });
});
