import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request, Response } from "express";

const h = vi.hoisted(() => ({ rpcs: [] as string[], exchanges: 0, sessionBound: true }));

vi.mock("@/services/connectors/core/connector-events", () => ({ recordConnectorEvent: vi.fn(async () => undefined) }));
vi.mock("@/services/tenants/founder-activity-alert", () => ({ notifyFounderActivity: vi.fn(async () => undefined) }));
vi.mock("@/services/tenants/active-tenant", () => ({ syncActiveTenant: vi.fn(async () => undefined) }));
vi.mock("@/services/connectors/core/token", () => ({ handleConnectorAccountSwap: vi.fn(async () => undefined) }));
vi.mock("@/services/secrets/vault", () => ({ getSecret: vi.fn(async () => null) }));
vi.mock("@/services/auth/tenant-role", () => ({ loadTenantRole: async () => "owner", loadTenantRoleFor: async () => "owner" }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: vi.fn(async () => null) }));
vi.mock("@/services/supabase", () => {
  const client = { rpc: async (fn: string) => { h.rpcs.push(fn); return { data: [], error: null }; } };
  return { serviceClient: () => client, serverClientFromBearer: () => client };
});
vi.mock("@/services/connectors/core/registry", () => {
  const connector = () => ({
    slug: "x",
    serverId: "x",
    bindCallbackToSession: h.sessionBound,
    exchangeCode: async () => { h.exchanges += 1; throw new Error("must not exchange"); },
  });
  return {
    isKnownConnector: (slug: string) => slug === "linkedin_ads" || slug === "linear",
    getConnector: () => connector(),
  };
});

import { connectorCallback } from "../connector";
import { toAppReturn } from "../mobile-return";

process.env.WEB_ORIGIN = "http://localhost:3040";

type Res = Response & { statusCode: number; body: any; location: string | null };
function mockRes(): Res {
  const res: Record<string, unknown> = { statusCode: 200, body: null, location: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.redirect = (c: number, url: string) => { res.statusCode = c; res.location = url; return res; };
  return res as unknown as Res;
}

async function land(connector: string, query: Record<string, string>): Promise<Res> {
  const r = mockRes();
  await connectorCallback({ params: { connector }, query, headers: {} } as unknown as Request, r);
  return r;
}

beforeEach(() => {
  h.rpcs.length = 0;
  h.exchanges = 0;
});

const LINKEDIN_CANCEL = {
  error: "user_cancelled_login",
  error_description: "The user cancelled LinkedIn login",
  state: "abc.def",
};

describe("a provider sign-in the founder did not finish", () => {
  it.each([[true, "linkedin_ads"], [false, "linear"]])("sends the founder back to Zavi, not to raw JSON (session bound %s, %s)", async (bound, slug) => {
    h.sessionBound = bound;
    const r = await land(slug, LINKEDIN_CANCEL);
    expect(r.statusCode).toBe(302);
    expect(r.body).toBeNull();
    const url = new URL(r.location!);
    expect(url.origin).toBe("http://localhost:3040");
    expect(url.pathname).toBe("/workspace");
    expect(Object.fromEntries(url.searchParams)).toEqual({ tab: "settings", connect_error: "permission_denied", provider: slug });
  });

  it("repeats nothing the provider sent, so the query cannot inject copy or a target", async () => {
    h.sessionBound = true;
    const r = await land("linkedin_ads", { ...LINKEDIN_CANCEL, error: "x&provider=evil", error_description: "<script>" });
    expect(r.location).not.toContain("script");
    expect(r.location).not.toContain("evil");
  });

  it("touches no state and saves no connection, so the sign-in can still be retried from LinkedIn's page", async () => {
    h.sessionBound = false;
    await land("linear", LINKEDIN_CANCEL);
    expect(h.rpcs).toEqual([]);
    expect(h.exchanges).toBe(0);
  });

  it("covers a provider that only drops the code and keeps the state", async () => {
    h.sessionBound = false;
    expect((await land("linear", { state: "s" })).location).toContain("connect_error=permission_denied");
  });

  it("covers a cancel that lost its state", async () => {
    h.sessionBound = false;
    expect((await land("linear", { error: "access_denied" })).location).toContain("connect_error=permission_denied");
  });

  it("lands in the phone app with the code the app already has copy for", async () => {
    h.sessionBound = true;
    const r = await land("linkedin_ads", LINKEDIN_CANCEL);
    expect(toAppReturn(r.location!, "http://localhost:3040")).toBe("zavi://connectors/done?tab=settings&connect_error=permission_denied&provider=linkedin_ads");
  });

  it("still refuses a bare request that carries nothing at all", async () => {
    const r = await land("linkedin_ads", {});
    expect(r.statusCode).toBe(400);
    expect(r.body.error.code).toBe("missing_params");
  });

  it("still 404s an unknown connector before anything else, even when it looks cancelled", async () => {
    const r = await land("nope", LINKEDIN_CANCEL);
    expect(r.statusCode).toBe(404);
    expect(r.location).toBeNull();
  });
});
