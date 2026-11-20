import { describe, it, expect, vi, beforeEach } from "vitest";
const audit = vi.hoisted(() => ({ record: vi.fn(async (..._a: unknown[]) => undefined) }));
vi.mock("@/services/connectors/core/connector-events", () => ({ recordConnectorEvent: audit.record }));

type Call = { table: string; op: string; filters: Array<[string, string, unknown]>; payload?: unknown };
const m = vi.hoisted(() => ({
  calls: [] as Call[],
  rows: [] as Array<{ tenant_id: string; slug: string; team_id: string }>,
  disconnect: vi.fn(async () => {}),
  disconnectTenantShop: vi.fn(async () => undefined),
  storedShop: vi.fn(async (): Promise<string | null> => "zavi-test-store.myshopify.com"),
}));

function builder(table: string) {
  const call: Call = { table, op: "select", filters: [] };
  m.calls.push(call);
  const match = () => m.rows.filter((r) => call.filters.every(([k, op, v]) =>
    op === "eq" ? (r as Record<string, unknown>)[k] === v : String((r as Record<string, unknown>)[k]).startsWith(String(v).replace("%", ""))));
  const q: any = {
    select: () => q,
    delete: () => { call.op = "delete"; return q; },
    update: (p: unknown) => { call.op = "update"; call.payload = p; return q; },
    eq: (k: string, v: unknown) => { call.filters.push([k, "eq", v]); return q; },
    like: (k: string, v: unknown) => { call.filters.push([k, "like", v]); return q; },
    limit: async () => ({ data: match() }),
    maybeSingle: async () => ({ data: match()[0] ?? null }),
    then: (resolve: (v: unknown) => void) => {
      if (call.op === "delete" && table === "connector_metadata") {
        const gone = new Set(match());
        m.rows = m.rows.filter((r) => !gone.has(r));
      }
      resolve({ error: null });
    },
  };
  return q;
}

vi.mock("@/services/auth/middleware", () => ({ requireAuth: async () => ({ tenant_id: "T1", user_id: "U1" }) }));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ from: (t: string) => builder(t) }) }));
vi.mock("@/services/connectors/composio/catalog", () => ({
  listComposioCatalog: async () => { throw new Error("disconnect must not depend on the catalog"); },
  isConnectable: () => true, lookupAuthConfigId: vi.fn(), ensureAuthConfigForConnect: vi.fn(), ensureToolkitOnMcpServer: vi.fn(),
}));
vi.mock("@/services/connectors/composio/api", () => ({ composioLink: vi.fn(), composioVerifyActive: vi.fn(), composioDisconnect: m.disconnect }));
vi.mock("@/services/connectors/shopify/store", () => ({
  rememberShopDomain: vi.fn(),
  storedShop: m.storedShop,
  disconnectTenantShop: m.disconnectTenantShop,
}));

import { composioDisconnectRoute } from "../composio";

function res() { const r: any = { statusCode: 200, body: null, status(c: number) { r.statusCode = c; return r; }, json(b: unknown) { r.body = b; return r; } }; return r; }
const req = (toolkit: string) => ({ params: { toolkit }, body: {}, query: {} }) as never;
const serverUpdates = () => m.calls.filter((c) => c.table === "tenant_mcp_servers" && c.op === "update");

beforeEach(() => {
  audit.record.mockClear();
  m.calls = [];
  m.disconnect.mockClear();
  m.disconnectTenantShop.mockClear();
  m.storedShop.mockClear();
  m.storedShop.mockResolvedValue("zavi-test-store.myshopify.com");
  m.rows = [
    { tenant_id: "T1", slug: "composio.gmail", team_id: "ca_g" },
    { tenant_id: "T1", slug: "composio.notion", team_id: "ca_n" },
    { tenant_id: "T2", slug: "composio.gmail", team_id: "ca_other" },
  ];
});

describe("composioDisconnectRoute", () => {
  it("removing gmail while notion remains leaves tenant_mcp_servers alone", async () => {
    const r = res();
    await composioDisconnectRoute(req("gmail"), r);
    expect(r.statusCode).toBe(200);
    expect(m.disconnect).toHaveBeenCalledWith("ca_g");
    expect(m.rows.map((x) => `${x.tenant_id}:${x.slug}`)).toEqual(["T1:composio.notion", "T2:composio.gmail"]);
    expect(serverUpdates()).toEqual([]);
    expect(audit.record).toHaveBeenCalledWith({ tenant_id: "T1", slug: "composio.gmail", action: "disconnect", actor_user_id: expect.any(String), via: "composio_disconnect" });
  });

  it("removing the last composio app disables the tenant's server row (scoped to the tenant)", async () => {
    m.rows = m.rows.filter((x) => x.slug !== "composio.notion");
    const r = res();
    await composioDisconnectRoute(req("gmail"), r);
    expect(r.statusCode).toBe(200);
    const ups = serverUpdates();
    expect(ups).toHaveLength(1);
    expect(ups[0].payload).toEqual({ enabled: false });
    expect(ups[0].filters).toContainEqual(["tenant_id", "eq", "T1"]);
  });

  it("a toolkit the catalog no longer lists is still disconnectable; another tenant's row is untouched", async () => {
    m.rows.push({ tenant_id: "T1", slug: "composio.oldapp", team_id: "ca_o" }, { tenant_id: "T2", slug: "composio.oldapp", team_id: "ca_o2" });
    const r = res();
    await composioDisconnectRoute(req("oldapp"), r);
    expect(r.statusCode).toBe(200);
    expect(m.disconnect).toHaveBeenCalledWith("ca_o");
    expect(m.disconnect).not.toHaveBeenCalledWith("ca_o2");
    expect(m.rows.some((x) => x.tenant_id === "T2" && x.slug === "composio.oldapp")).toBe(true);
    expect(m.rows.some((x) => x.tenant_id === "T1" && x.slug === "composio.oldapp")).toBe(false);
  });

  it("upstream revoke fails (not a 404) → error returned, local row KEPT so the user can retry", async () => {
    m.disconnect.mockRejectedValueOnce(new Error("composio delete HTTP 503"));
    const r = res();
    await composioDisconnectRoute(req("gmail"), r);
    expect(r.statusCode).toBe(502);
    expect(r.body.error.code).toBe("upstream_disconnect_failed");
    expect(m.rows.some((x) => x.tenant_id === "T1" && x.slug === "composio.gmail")).toBe(true);
    expect(m.calls.some((c) => c.op === "delete")).toBe(false);
    expect(serverUpdates()).toEqual([]);
  });

  it("no row for this tenant → 404 unknown_toolkit, nothing deleted upstream", async () => {
    const r = res();
    await composioDisconnectRoute(req("hubspot"), r);
    expect(r.statusCode).toBe(404);
    expect(r.body.error.code).toBe("unknown_toolkit");
    expect(m.disconnect).not.toHaveBeenCalled();
  });

  it("Shopify disconnect uses the full shop cleanup so Zavi's durable refresh grant is erased too", async () => {
    m.rows.push({ tenant_id: "T1", slug: "composio.shopify", team_id: "ca_shop" });
    const r = res();
    await composioDisconnectRoute(req("shopify"), r);
    expect(r.statusCode).toBe(200);
    expect(m.storedShop).toHaveBeenCalledWith("T1");
    expect(m.disconnectTenantShop).toHaveBeenCalledWith("T1", "zavi-test-store.myshopify.com", "ca_shop", "composio_disconnect");
    expect(m.disconnect).not.toHaveBeenCalledWith("ca_shop");
  });

  it("keeps Shopify Disconnect retryable when its stored shop identity is missing", async () => {
    m.rows.push({ tenant_id: "T1", slug: "composio.shopify", team_id: "ca_shop" });
    m.storedShop.mockResolvedValueOnce(null);
    const r = res();
    await composioDisconnectRoute(req("shopify"), r);
    expect(r.statusCode).toBe(502);
    expect(r.body.error.code).toBe("shopify_store_unknown");
    expect(m.disconnectTenantShop).not.toHaveBeenCalled();
  });
});
