import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  verify: vi.fn(),
  exchange: vi.fn(),
  connections: vi.fn(),
  rpc: vi.fn(),
  tenant: vi.fn(),
  linked: vi.fn(),
}));

vi.mock("../session", () => ({
  verifyShopifyIdToken: m.verify,
  exchangeShopifyOnlineToken: m.exchange,
}));
vi.mock("../store", () => ({ connectionsForShop: m.connections }));
vi.mock("../app-identity", () => ({ resolveLinkedShopifyAppMember: m.linked }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (id: string) => id,
  tenantRpc: m.rpc,
  tenantClient: () => ({
    from: () => ({
      select: () => ({ maybeSingle: m.tenant }),
    }),
  }),
}));

import { resolveShopifyAppContext } from "../app-context";

const session = {
  token: "id-token",
  shop: "zavi-test-store.myshopify.com",
  shopify_user_id: "42",
  payload: {},
};

function grant(overrides: Record<string, unknown> = {}) {
  return {
    access_token: "online-token",
    scope: "read_orders",
    expires_in: 86_400,
    associated_user_scope: "read_orders",
    scopes: ["read_orders"],
    user_scopes: ["read_orders"],
    associated_user: {
      id: "42",
      first_name: "Shop",
      last_name: "Owner",
      email: "owner@example.com",
      account_owner: true,
      collaborator: false,
      email_verified: true,
      ...overrides,
    },
  };
}

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  m.verify.mockResolvedValue(session);
  m.exchange.mockResolvedValue(grant());
  m.connections.mockResolvedValue([{ tenant_id: "tenant-1" }]);
  m.tenant.mockResolvedValue({ data: { display_name: "Zavi Store" }, error: null });
  m.linked.mockResolvedValue(null);
  m.rpc.mockResolvedValue({ data: [{ user_id: "user-1", role: "admin" }], error: null });
});

describe("Shopify App Home workspace identity", () => {
  it("links a verified Shopify email only to its exact workspace membership", async () => {
    await expect(resolveShopifyAppContext("Bearer token")).resolves.toMatchObject({
      shop: session.shop,
      tenant_id: "tenant-1",
      tenant_name: "Zavi Store",
      user_id: "user-1",
      role: "admin",
    });
    expect(m.rpc).toHaveBeenCalledWith("tenant-1", "resolve_shopify_app_member", {
      p_tenant_id: "tenant-1",
      p_email: "owner@example.com",
    });
  });

  it("fails closed when the Shopify staff email is not a workspace member", async () => {
    m.rpc.mockResolvedValue({ data: [], error: null });
    await expect(resolveShopifyAppContext("Bearer token")).rejects.toMatchObject({ code: "user_not_linked" });
  });

  it("uses the installer link when Shopify and Zavi emails differ", async () => {
    m.exchange.mockResolvedValue(grant({ email: "reviewer@shopify.com", email_verified: false }));
    m.linked.mockResolvedValue({ user_id: "user-1", role: "owner" });
    await expect(resolveShopifyAppContext("Bearer token")).resolves.toMatchObject({
      tenant_id: "tenant-1",
      user_id: "user-1",
      role: "owner",
    });
    expect(m.linked).toHaveBeenCalledWith({
      tenant_id: "tenant-1",
      shop: session.shop,
      shopify_user_id: "42",
    });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("does not use an unverified Shopify email for a Zavi identity", async () => {
    m.exchange.mockResolvedValue(grant({ email_verified: false }));
    await expect(resolveShopifyAppContext("Bearer token")).rejects.toMatchObject({ code: "user_not_linked" });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("refuses a shop connected to more than one workspace", async () => {
    m.connections.mockResolvedValue([{ tenant_id: "tenant-1" }, { tenant_id: "tenant-2" }]);
    await expect(resolveShopifyAppContext("Bearer token")).rejects.toMatchObject({ code: "shop_ambiguous" });
  });
});
