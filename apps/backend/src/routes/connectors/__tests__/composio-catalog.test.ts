import { describe, it, expect, vi, beforeEach } from "vitest";
import { CONNECTOR_DESCRIPTORS, railFor, NATIVE_DESCRIPTOR_TO_COMPOSIO } from "@zavi/shared";

const m = vi.hoisted(() => ({
  requested: [] as { app_slug: string }[],
  auth: { tenant_id: "T1", user_id: "U1" } as { tenant_id: string; user_id: string } | null,
  ensureAuthConfigForConnect: vi.fn(),
  composioLink: vi.fn(),
  rpc: vi.fn(),
  recordAppRequest: vi.fn(async () => ({ requested: true, emailed: true })),
  tenantHasShop: vi.fn(async () => false),
  storedShop: vi.fn(async () => null as string | null),
}));
vi.mock("@/services/connectors/shopify/store", () => ({
  tenantHasShop: m.tenantHasShop,
  storedShop: m.storedShop,
  rememberShopDomain: vi.fn(async () => null),
}));
vi.mock("@/services/connectors/app-request-alert", () => ({
  recordAppRequest: m.recordAppRequest,
  defaultAppRequestDeps: async () => ({}),
}));
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async (_req: unknown, res: { status: (c: number) => { json: (b: unknown) => void } }) => {
    if (!m.auth) { res.status(401).json({ error: { code: "unauthorized" } }); return null; }
    return m.auth;
  },
}));
vi.mock("@/services/connectors/composio/catalog", () => ({
  listComposioCatalog: async () => [
    { slug: "notion", name: "Notion", logo: "n", category: "Productivity", managed: ["OAUTH2"], schemes: ["OAUTH2"], no_auth: false },
    { slug: "acme", name: "Acme", logo: "a", category: null, managed: [], schemes: ["OAUTH2"], no_auth: false },
    { slug: "slack", name: "Slack", logo: "s", category: null, managed: ["OAUTH2"], schemes: ["OAUTH2"], no_auth: false },
    { slug: "instagram", name: "Instagram", logo: "i", category: null, managed: ["OAUTH2"], schemes: ["OAUTH2"], no_auth: false },
    { slug: "stripe", name: "Stripe", logo: "st", category: null, managed: ["OAUTH2"], schemes: ["OAUTH2"], no_auth: false },
    { slug: "linear", name: "Linear", logo: "li", category: null, managed: ["OAUTH2"], schemes: ["OAUTH2"], no_auth: false },
    { slug: "hackernews", name: "Hacker News", logo: "h", category: null, managed: [], schemes: ["NO_AUTH"], no_auth: true },
    { slug: "shopify", name: "Shopify", logo: "sh", category: "Ecommerce", managed: ["OAUTH2"], schemes: ["OAUTH2"], no_auth: false },
  ],
  isConnectable: (t: { managed: string[]; no_auth: boolean }) => t.no_auth || t.managed.length > 0,
  lookupAuthConfigId: vi.fn(),
  ensureAuthConfigForConnect: m.ensureAuthConfigForConnect,
  ensureToolkitOnMcpServer: vi.fn(),
}));
vi.mock("@/services/connectors/composio/api", () => ({
  composioLink: m.composioLink,
  composioVerifyActive: vi.fn(),
  composioDisconnect: vi.fn(),
  composioNewestActiveAccount: vi.fn(),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: m.rpc,
    from: () => { const q: any = { select: () => q, eq: async () => ({ data: m.requested }) }; return q; },
  }),
}));
import { composioToolkits, composioConnectStart, composioRequestApp, NATIVE_ONLY_TOOLKITS, TILE_TOOLKITS } from "../composio";

function res() { const r: any = { statusCode: 200, body: null, status(c: number) { r.statusCode = c; return r; }, json(b: unknown) { r.body = b; return r; } }; return r; }

beforeEach(() => {
  m.requested = [{ app_slug: "acme" }];
  m.auth = { tenant_id: "T1", user_id: "U1" };
  m.ensureAuthConfigForConnect.mockReset();
  m.composioLink.mockReset();
  m.rpc.mockReset();
  m.recordAppRequest.mockClear();
});

describe("GET /toolkits", () => {
  it("lists connectable + coming-soon + no-auth apps, hides native-rail (Slack, Stripe, Linear) and tile apps, returns requested", async () => {
    const r = res();
    await composioToolkits({} as any, r);
    expect(r.statusCode).toBe(200);
    expect(r.body.provider).toBeUndefined();
    expect(r.body.toolkits).toEqual([
      { slug: "notion", name: "Notion", logo: "n", category: "Productivity", connectable: true },
      { slug: "acme", name: "Acme", logo: "a", category: null, connectable: false },
      { slug: "hackernews", name: "Hacker News", logo: "h", category: null, connectable: true },
      { slug: "shopify", name: "Shopify", logo: "sh", category: "Ecommerce", connectable: true },
    ]);
    expect(r.body.requested).toEqual(["acme"]);
  });

  it("every native settings tile is mapped to a Composio decision (hide list covers native OAuth, spec 8)", () => {
    const tiles = CONNECTOR_DESCRIPTORS.filter((d) => d.settingsTile).map((d) => d.slug);
    const missing = tiles.filter((s) => !(s in NATIVE_DESCRIPTOR_TO_COMPOSIO));
    expect(missing).toEqual([]);
    for (const slugs of Object.values(NATIVE_DESCRIPTOR_TO_COMPOSIO))
      for (const c of slugs) expect(railFor(c) === "native" ? NATIVE_ONLY_TOOLKITS.has(c) : TILE_TOOLKITS.has(c)).toBe(true);
    expect([...TILE_TOOLKITS].sort()).toEqual([
      "google_analytics",
      "google_search_console",
      "instagram",
      "reddit",
      "reddit_ads",
      "tiktok_ads",
    ]);
    expect(NATIVE_ONLY_TOOLKITS.has("stripe")).toBe(true);
    expect(NATIVE_ONLY_TOOLKITS.has("telegram")).toBe(true);
  });
});

describe("POST /:toolkit/connect for a native-rail app", () => {
  for (const kit of ["linear", "stripe", "slack"]) {
    it(`${kit} answers 404 unknown_toolkit and never mints state or creates a config`, async () => {
      const r = res();
      await composioConnectStart({ params: { toolkit: kit }, body: {}, query: {} } as any, r);
      expect(r.statusCode).toBe(404);
      expect(r.body.error.code).toBe("unknown_toolkit");
      expect(m.rpc).not.toHaveBeenCalled();
      expect(m.ensureAuthConfigForConnect).not.toHaveBeenCalled();
      expect(m.composioLink).not.toHaveBeenCalled();
    });
  }
});

describe("POST /:toolkit/connect for Shopify", () => {
  it("refuses the generic Composio link and says the App Store app is in review, touching neither Composio nor the state table", async () => {
    const r = res();
    await composioConnectStart({ params: { toolkit: "shopify" }, body: { connection_data: { subdomain: "acme" } }, query: {} } as any, r);
    expect(r.statusCode).toBe(409);
    expect(r.body.error.code).toBe("shopify_use_app_install");
    expect(r.body.error.message).toMatch(/in App Store review/);
    expect(m.ensureAuthConfigForConnect).not.toHaveBeenCalled();
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.composioLink).not.toHaveBeenCalled();
  });
});

describe("POST /:toolkit/request (I need it)", () => {
  it("401 without auth, records nothing", async () => {
    m.auth = null;
    const r = res();
    await composioRequestApp({ params: { toolkit: "acme" }, body: {} } as any, r);
    expect(r.statusCode).toBe(401);
    expect(m.recordAppRequest).not.toHaveBeenCalled();
  });

  it("records for auth.tenant_id even when the body names another tenant", async () => {
    const r = res();
    await composioRequestApp({ params: { toolkit: "acme" }, body: { tenant_id: "OTHER", user_id: "OTHER" } } as any, r);
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ requested: true });
    expect(m.recordAppRequest).toHaveBeenCalledWith(
      { tenant_id: "T1", user_id: "U1", app_slug: "acme", app_name: "Acme" }, expect.anything(),
    );
  });

  for (const kit of ["notion", "slack", "stripe", "not-in-catalog", "<script>"]) {
    it(`${kit} is not requestable: 404, nothing recorded`, async () => {
      const r = res();
      await composioRequestApp({ params: { toolkit: kit }, body: {} } as any, r);
      expect(r.statusCode).toBe(404);
      expect(r.body.error.code).toBe("unknown_toolkit");
      expect(m.recordAppRequest).not.toHaveBeenCalled();
    });
  }
});
