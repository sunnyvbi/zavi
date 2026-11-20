
import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  tables: {} as Record<string, unknown>,
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.auth }));
vi.mock("@/services/sites/store", () => ({
  siteStore: () => ({
    listForTenant: async () => [],
    get: async () => null,
    getByRun: async () => null,
    getByRepo: async () => null,
  }),
}));
vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        or: () => builder,
        is: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({ data: mocks.tables[table] ?? null, error: null }),
      };
      return builder;
    },
  }),
}));
vi.mock("@/services/settings", () => ({
  getStringSetting: async () => "public",
  getBoolSetting: async () => false,
  getSetting: async () => ({ name: null, description: null }),
  setTenantSetting: vi.fn(),
}));
vi.mock("../../services/workspace/appTextClean", () => ({
  cleanAppTitle: (v: string) => v,
  cleanAppDescription: (v: string) => v,
}));

import { getWebsiteOverviewHandler } from "../website-overview";

function response() {
  let status = 200;
  let body: unknown;
  const res = {
    status: vi.fn((value: number) => { status = value; return res; }),
    json: vi.fn((value: unknown) => { body = value; return res; }),
  } as unknown as Response;
  return { res, result: () => ({ status, body: body as { app?: { deployed_url?: string | null } } }) };
}

const req = { headers: { authorization: "Bearer t" } } as unknown as Request;

describe("GET /api/website/overview — deployed_url precedence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ tenant_id: "tenant-a", user_id: "user-a" });
    mocks.tables = {};
  });

  it("never returns the Render hosting URL as the app's public address", async () => {
    mocks.tables.tenants = { display_name: "Acme", product_url: { marketing: "https://dead.example.com/" }, created_at: null };
    mocks.tables.tenant_resources = { external_ref: { url: "https://real-app.onrender.com/", render_service_id: "srv-1" } };
    const { res, result } = response();
    await getWebsiteOverviewHandler(req, res);
    expect(result().body.app?.deployed_url).not.toContain("onrender");
    expect(result().body.app?.deployed_url).toBe("https://dead.example.com/");
  });

  it("a product_url pointer that names the Render host is hidden too", async () => {
    mocks.tables.tenants = { display_name: "Acme", product_url: { marketing: "https://real-app.onrender.com/" }, created_at: null };
    mocks.tables.tenant_resources = null;
    const { res, result } = response();
    await getWebsiteOverviewHandler(req, res);
    expect(result().body.app?.deployed_url).toBeNull();
  });

  it("a live built-in address wins over the pointer", async () => {
    mocks.tables.tenants = { display_name: "Acme", product_url: { marketing: "https://my-site.com/" }, created_at: null };
    mocks.tables.tenant_resources = { external_ref: { hostname: "acme.zaviagent.com", status: "live" } };
    const { res, result } = response();
    await getWebsiteOverviewHandler(req, res);
    expect(result().body.app?.deployed_url).toBe("https://acme.zaviagent.com/");
  });

  it("a still-verifying built-in address does not win", async () => {
    mocks.tables.tenants = { display_name: "Acme", product_url: { marketing: "https://my-site.com/" }, created_at: null };
    mocks.tables.tenant_resources = { external_ref: { hostname: "acme.zaviagent.com", status: "verifying" } };
    const { res, result } = response();
    await getWebsiteOverviewHandler(req, res);
    expect(result().body.app?.deployed_url).toBe("https://my-site.com/");
  });

  it("falls back to the product_url pointer when there is no provisioned host", async () => {
    mocks.tables.tenants = { display_name: "Acme", product_url: { marketing: "https://my-site.com/" }, created_at: null };
    mocks.tables.tenant_resources = null;
    const { res, result } = response();
    await getWebsiteOverviewHandler(req, res);
    expect(result().body.app?.deployed_url).toBe("https://my-site.com/");
  });

  it("ignores a non-https built-in hostname and falls back to the pointer", async () => {
    mocks.tables.tenants = { display_name: "Acme", product_url: { marketing: "https://my-site.com/" }, created_at: null };
    mocks.tables.tenant_resources = { external_ref: { hostname: "not a host", status: "live" } };
    const { res, result } = response();
    await getWebsiteOverviewHandler(req, res);
    expect(result().body.app?.deployed_url).toBe("https://my-site.com/");
  });

  it("returns null deployed_url when neither a host nor a pointer exists", async () => {
    mocks.tables.tenants = { display_name: "Acme", product_url: {}, created_at: null };
    mocks.tables.tenant_resources = null;
    const { res, result } = response();
    await getWebsiteOverviewHandler(req, res);
    expect(result().body.app?.deployed_url).toBeNull();
  });
});
