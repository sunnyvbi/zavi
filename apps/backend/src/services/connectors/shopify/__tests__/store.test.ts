import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  account: { subdomain: "acme" } as { subdomain: string | null },
  rows: [] as Array<{ tenant_id: string; team_id: string | null }>,
  updateMatched: true,
  updates: [] as Array<{ values: unknown; filters: Array<[string, unknown]> }>,
  deletes: [] as Array<Array<[string, unknown]>>,
  disconnect: vi.fn(async (_id: string) => undefined),
  deletePending: vi.fn(async (): Promise<string[]> => []),
  deletePendingTenant: vi.fn(async (): Promise<boolean> => true),
  listPending: vi.fn(async (): Promise<string[]> => []),
  logEvent: vi.fn(async () => undefined),
  rpcCalls: [] as Array<[string, Record<string, unknown>]>,
  deleteAllLinks: vi.fn(async () => undefined),
  deleteTenantLinks: vi.fn(async () => undefined),
}));
vi.mock("@/services/connectors/composio/api", () => ({
  composioGetAccount: async () => ({ status: "ACTIVE", status_reason: null, updated_at: null, user_id: "T1", subdomain: m.account.subdomain }),
  composioDisconnect: m.disconnect,
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: m.logEvent }));
vi.mock("../pending-install", () => ({
  deletePendingShopifyInstallForShop: m.deletePending,
  deletePendingShopifyInstallForTenant: m.deletePendingTenant,
  listPendingShopifyAccountsForShop: m.listPending,
}));
vi.mock("../app-identity", () => ({
  deleteShopifyAppMemberLinksForShop: m.deleteAllLinks,
  deleteTenantShopifyAppMemberLinks: m.deleteTenantLinks,
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  shopifyRpc: async (name: string, args: Record<string, unknown>) => {
    m.rpcCalls.push([name, args]);
    return { data: m.rows.filter((r) => r.team_id).map((r) => ({ tenant_id: r.tenant_id, connected_account_id: r.team_id })), error: null };
  },
  tenantClient: (tid: string) => ({
    from: (_table: string) => {
      const filters: Array<[string, unknown]> = [["tenant_id", tid]];
      const q: any = {
        select: () => q,
        update: (values: unknown) => { m.updates.push({ values, filters }); return q; },
        delete: () => { m.deletes.push(filters); return q; },
        like: () => q,
        limit: async () => ({ data: [], error: null }),
        maybeSingle: async () => ({
          data: filters.some(([k]) => k === "team_id")
            ? (m.updateMatched ? { tenant_id: "T1" } : null)
            : (m.rows[0] ? { team_name: "acme.myshopify.com" } : null),
          error: null,
        }),
        eq: (k: string, v: unknown) => { filters.push([k, v]); return q; },
        then: (resolve: (v: unknown) => void) => resolve({ error: null }),
      };
      return q;
    },
  }),
}));
import { connectionsForShop, disconnectShop, disconnectTenantShop, rememberShopDomain, storedShop, tenantHasShop } from "../store";

beforeEach(() => {
  m.account = { subdomain: "acme" };
  m.rows = [];
  m.updateMatched = true;
  m.updates = [];
  m.deletes = [];
  m.rpcCalls = [];
  m.disconnect.mockClear();
  m.deletePending.mockReset();
  m.deletePending.mockResolvedValue([]);
  m.deletePendingTenant.mockReset();
  m.deletePendingTenant.mockResolvedValue(true);
  m.listPending.mockReset();
  m.listPending.mockResolvedValue([]);
  m.logEvent.mockClear();
  m.deleteAllLinks.mockClear();
  m.deleteTenantLinks.mockClear();
});

describe("rememberShopDomain", () => {
  it("reads the store from the Composio account and saves it on the tenant's row", async () => {
    expect(await rememberShopDomain("T1", "ca_1")).toBe("acme.myshopify.com");
    expect(m.updates[0].values).toEqual({ team_name: "acme.myshopify.com" });
    expect(m.updates[0].filters).toEqual([["tenant_id", "T1"], ["slug", "composio.shopify"], ["team_id", "ca_1"]]);
  });
  it("saves nothing when Composio has no subdomain", async () => {
    m.account = { subdomain: null };
    expect(await rememberShopDomain("T1", "ca_1")).toBeNull();
    expect(m.updates).toEqual([]);
  });
  it("fails closed when the expected connector row was not updated", async () => {
    m.updateMatched = false;
    expect(await rememberShopDomain("T1", "ca_1")).toBeNull();
  });
});

describe("storedShop", () => {
  it("returns the store saved on the tenant's row, or null when there is none", async () => {
    m.rows = [{ tenant_id: "T1", team_id: "ca_1" }];
    expect(await storedShop("T1")).toBe("acme.myshopify.com");
    m.rows = [];
    expect(await storedShop("T1")).toBeNull();
  });
});

describe("tenantHasShop", () => {
  it("is true only for the stored store", async () => {
    m.rows = [{ tenant_id: "T1", team_id: "ca_1" }];
    expect(await tenantHasShop("T1", "acme.myshopify.com")).toBe(true);
    expect(await tenantHasShop("T1", "other.myshopify.com")).toBe(false);
  });
});

describe("disconnectShop", () => {
  it("revokes at Composio and drops the row for every tenant holding that store", async () => {
    m.rows = [{ tenant_id: "T1", team_id: "ca_1" }, { tenant_id: "T2", team_id: "ca_2" }, { tenant_id: "T3", team_id: null }];
    expect(await connectionsForShop("acme.myshopify.com")).toEqual([
      { tenant_id: "T1", connected_account_id: "ca_1" },
      { tenant_id: "T2", connected_account_id: "ca_2" },
    ]);
    expect(await disconnectShop("acme.myshopify.com", "app/uninstalled")).toBe(2);
    expect(m.rpcCalls).toContainEqual(["shopify_connections_for_shop", { p_shop: "acme.myshopify.com" }]);
    expect(m.disconnect.mock.calls.map((c) => c[0])).toEqual(["ca_1", "ca_2"]);
    expect(m.deletes).toHaveLength(2);
    expect(m.deletes[0]).toEqual(expect.arrayContaining([["tenant_id", "T1"], ["slug", "composio.shopify"], ["team_id", "ca_1"]]));
    expect(m.deleteAllLinks).toHaveBeenCalledWith("acme.myshopify.com");
  });
  it("revokes an unfinished imported account before forgetting the pending install", async () => {
    m.listPending.mockResolvedValueOnce(["ca_pending"]);
    expect(await disconnectShop("acme.myshopify.com", "app/uninstalled")).toBe(0);
    expect(m.disconnect).toHaveBeenCalledWith("ca_pending");
    expect(m.deletePending).toHaveBeenCalledWith("acme.myshopify.com");
    expect(m.deleteAllLinks).toHaveBeenCalledWith("acme.myshopify.com");
  });
  it("keeps the pending install when its account cannot be revoked", async () => {
    m.listPending.mockResolvedValueOnce(["ca_pending"]);
    m.disconnect.mockRejectedValueOnce(new Error("composio down"));
    await expect(disconnectShop("acme.myshopify.com", "app/uninstalled")).rejects.toThrow("composio down");
    expect(m.deletePending).not.toHaveBeenCalled();
  });
  it("keeps the row and fails when the Composio revoke fails, so Shopify retries", async () => {
    m.rows = [{ tenant_id: "T1", team_id: "ca_1" }, { tenant_id: "T2", team_id: "ca_2" }];
    m.disconnect.mockRejectedValueOnce(new Error("composio down"));
    await expect(disconnectShop("acme.myshopify.com", "shop/redact")).rejects.toThrow("shopify_disconnect_incomplete:1");
    expect(m.deletes).toHaveLength(1);
    expect(m.deletes[0]).toEqual(expect.arrayContaining([["team_id", "ca_2"]]));
  });
});

describe("disconnectTenantShop", () => {
  it("revokes and deletes only the authenticated tenant's exact account", async () => {
    await disconnectTenantShop("T1", "acme.myshopify.com", "ca_1", "composio_disconnect");
    expect(m.disconnect).toHaveBeenCalledWith("ca_1");
    expect(m.deletePendingTenant).toHaveBeenCalledWith("acme.myshopify.com", "T1");
    expect(m.deletes).toHaveLength(1);
    expect(m.deletes[0]).toEqual(expect.arrayContaining([
      ["tenant_id", "T1"], ["slug", "composio.shopify"], ["team_id", "ca_1"],
    ]));
    expect(m.deleteTenantLinks).toHaveBeenCalledWith("T1", "acme.myshopify.com");
  });

  it("does not erase local credentials or rows when upstream revocation fails", async () => {
    m.disconnect.mockRejectedValueOnce(new Error("composio down"));
    await expect(disconnectTenantShop("T1", "acme.myshopify.com", "ca_1", "composio_disconnect")).rejects.toThrow("composio down");
    expect(m.deletePendingTenant).not.toHaveBeenCalled();
    expect(m.deletes).toEqual([]);
  });
});
