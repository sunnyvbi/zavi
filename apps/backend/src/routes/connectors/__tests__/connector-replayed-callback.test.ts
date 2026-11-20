import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request, Response } from "express";

const h = vi.hoisted(() => ({
  rows: [] as Array<{ tenant_id: string; user_id: string }>,
  rpcError: null as { message: string } | null,
  exchanges: 0,
  stored: 0,
}));

vi.mock("@/services/connectors/core/connector-events", () => ({ recordConnectorEvent: vi.fn(async () => undefined) }));
vi.mock("@/services/tenants/founder-activity-alert", () => ({ notifyFounderActivity: vi.fn(async () => undefined) }));
vi.mock("@/services/tenants/active-tenant", () => ({ syncActiveTenant: vi.fn(async () => undefined) }));
vi.mock("@/services/connectors/core/token", () => ({ handleConnectorAccountSwap: vi.fn(async () => undefined) }));
vi.mock("@/services/secrets/vault", () => ({ getSecret: vi.fn(async () => null) }));
vi.mock("@/services/auth/tenant-role", () => ({ loadTenantRole: async () => "owner", loadTenantRoleFor: async () => "owner" }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: vi.fn(async () => null) }));
vi.mock("@/services/supabase", () => {
  const client = {
    rpc: async (fn: string) => {
      if (fn === "consume_oauth_state") {
        const rows = h.rows;
        h.rows = [];
        return { data: rows, error: h.rpcError };
      }
      h.stored += 1;
      return { data: null, error: null };
    },
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) }),
  };
  return { serviceClient: () => client, serverClientFromBearer: () => client };
});
vi.mock("@/services/connectors/core/registry", () => ({
  isKnownConnector: (slug: string) => slug === "linkedin_social",
  getConnector: () => ({
    slug: "linkedin_social",
    serverId: "linkedin_social",
    exchangeCode: async () => {
      h.exchanges += 1;
      return { secrets: {}, expiresInSec: null, metadata: { team_id: "t", team_name: "t", scopes: [] } };
    },
  }),
}));

import { connectorCallback } from "../connector";

process.env.WEB_ORIGIN = "http://localhost:3040";
process.env.BACKEND_PUBLIC_URL = "http://localhost:3041";

type Res = Response & { statusCode: number; body: any; location: string | null };
function mockRes(): Res {
  const res: Record<string, unknown> = { statusCode: 200, body: null, location: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.redirect = (c: number, url: string) => { res.statusCode = c; res.location = url; return res; };
  return res as unknown as Res;
}

async function open(query: Record<string, string>): Promise<Res> {
  const r = mockRes();
  await connectorCallback({ params: { connector: "linkedin_social" }, query, headers: {} } as unknown as Request, r);
  return r;
}

const CB = { code: "c", state: "s.cmV0dXJu" };

beforeEach(() => {
  h.rows = [];
  h.rpcError = null;
  h.exchanges = 0;
  h.stored = 0;
});

describe("GET OAuth callback opened with a state that is no longer valid", () => {
  it("unknown state redirects to the web app, never a JSON body", async () => {
    const r = await open(CB);
    expect(r.statusCode).toBe(302);
    expect(r.body).toBeNull();
    const url = new URL(r.location!);
    expect(url.origin).toBe("http://localhost:3040");
    expect(Object.fromEntries(url.searchParams)).toEqual({ tab: "settings", connect_error: "permission_denied", provider: "linkedin_social" });
    expect(h.exchanges).toBe(0);
    expect(h.stored).toBe(0);
  });

  it("reopening a callback that already connected redirects to the web app and does not connect twice", async () => {
    h.rows = [{ tenant_id: "ten", user_id: "usr" }];
    const first = await open(CB);
    expect(first.statusCode).toBe(302);
    expect(first.location).toContain("linkedin_social=connected");
    expect(h.exchanges).toBe(1);

    const replay = await open(CB);
    expect(replay.statusCode).toBe(302);
    expect(replay.body).toBeNull();
    expect(new URL(replay.location!).origin).toBe("http://localhost:3040");
    expect(replay.location).toContain("connect_error=permission_denied");
    expect(h.exchanges).toBe(1);
    expect(h.stored).toBe(1);
  });

  it("a failing state lookup also lands on the web app instead of a 500 JSON page", async () => {
    h.rpcError = { message: "db down" };
    const r = await open(CB);
    expect(r.statusCode).toBe(302);
    expect(r.body).toBeNull();
    expect(r.location).not.toContain("db");
    expect(new URL(r.location!).origin).toBe("http://localhost:3040");
  });
});
