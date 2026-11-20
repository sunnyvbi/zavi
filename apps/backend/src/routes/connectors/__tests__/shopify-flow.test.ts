import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import type { TenantId } from "@/services/tenant-client";
import { shopifyQueryMessage, signAppHomeInstallToken, signInstallToken, signInstallTokenForViewer, signShopifyAppLinkToken, verifyInstallToken, verifyShopifyAppLinkConfirmation } from "@/services/connectors/shopify/hmac";

const m = vi.hoisted(() => {
  class OAuthError extends Error {
    constructor(readonly code: string) { super(code); }
  }
  return {
    OAuthError,
    auth: { tenant_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", user_id: "11111111-1111-4111-8111-111111111111", email: "owner@store.com" } as { tenant_id: string; user_id: string; email: string | null } | null,
    consumeState: vi.fn(),
    storePending: vi.fn(),
    status: vi.fn(),
    pending: vi.fn(),
    reserve: vi.fn(),
    rotate: vi.fn(),
    acquireLease: vi.fn(),
    releaseLease: vi.fn(),
    setAccount: vi.fn(),
    complete: vi.fn(),
    exchange: vi.fn(),
    refresh: vi.fn(),
    lookupConfig: vi.fn(),
    managedConfig: false,
    configScheme: "BEARER_TOKEN",
    ensureToolkit: vi.fn(),
    importBearer: vi.fn(),
    patchBearer: vi.fn(),
    verifyActive: vi.fn(),
    verifyOwned: vi.fn(),
    disconnect: vi.fn(),
    storedAccount: vi.fn(),
    saveShop: vi.fn(),
    rpc: vi.fn(),
    linkAppMember: vi.fn(),
    linkAvailable: vi.fn(),
    connectedTenant: vi.fn(),
    adminRole: vi.fn(),
  };
});

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async (_req: unknown, res: any) => {
    if (!m.auth) { res.status(401).json({ error: { code: "unauthorized" } }); return null; }
    return m.auth;
  },
}));
vi.mock("@/services/connectors/shopify/pending-install", () => ({
  mintShopifyOAuthState: vi.fn(),
  consumeShopifyOAuthState: m.consumeState,
  storePendingShopifyInstall: m.storePending,
  getShopifyInstallStatus: m.status,
  getPendingShopifyInstall: m.pending,
  reservePendingShopifyInstall: m.reserve,
  persistRotatedShopifyGrant: m.rotate,
  acquireShopifyRefreshLease: m.acquireLease,
  releaseShopifyRefreshLease: m.releaseLease,
  setPendingComposioAccount: m.setAccount,
  completePendingShopifyInstall: m.complete,
}));
vi.mock("@/services/connectors/shopify/oauth", () => ({
  ShopifyOAuthError: m.OAuthError,
  exchangeShopifyCode: m.exchange,
  refreshShopifyGrant: m.refresh,
  shopifyAuthorizeUrl: vi.fn(),
}));
vi.mock("@/services/connectors/composio/catalog", () => ({
  lookupAuthConfigId: m.lookupConfig,
  ensureToolkitOnMcpServer: m.ensureToolkit,
}));
vi.mock("@/services/connectors/composio/api", () => ({
  composioGetAuthConfig: async (id: string) => ({ id, is_composio_managed: m.managedConfig, auth_scheme: m.configScheme, status: "ENABLED" }),
  authConfigSupportsBearerImport: (c: { is_composio_managed: boolean; auth_scheme: string | null; status: string | null }) => !c.is_composio_managed && c.auth_scheme === "BEARER_TOKEN" && c.status === "ENABLED",
  composioImportBearerToken: m.importBearer,
  composioPatchBearerToken: m.patchBearer,
  composioVerifyActive: m.verifyActive,
  composioVerifyOwned: m.verifyOwned,
  composioDisconnect: m.disconnect,
}));
vi.mock("@/services/connectors/composio/api-key", () => ({ buildComposioMcpUrl: () => "https://mcp.example/T1" }));
vi.mock("@/services/connectors/composio/connection-row", () => ({ storedComposioAccount: m.storedAccount }));
vi.mock("@/services/connectors/shopify/store", () => ({ saveShopDomain: m.saveShop, connectedTenantForShop: m.connectedTenant }));
vi.mock("@/services/connectors/shopify/app-identity", () => ({
  linkShopifyAppMember: m.linkAppMember,
  shopifyAppMemberLinkAvailable: m.linkAvailable,
  shopifyWorkspaceAdminRole: m.adminRole,
}));
vi.mock("@/services/connectors/core/connector-events", () => ({ recordConnectorEvent: vi.fn() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
vi.mock("@/services/tenants/founder-activity-alert", () => ({ notifyFounderActivity: vi.fn() }));
vi.mock("@/services/tenant-client", () => ({ asTenantId: (t: string) => t, tenantRpc: (_tid: string, name: string, args: Record<string, unknown>) => m.rpc(name, { ...args, p_tenant_id: _tid }) }));

import { finishShopifyClaim, shopifyCallback, shopifyClaim, shopifyInstallStatus } from "../shopify";

const SECRET = "shopify-secret";
const INSTALLATION_ID = "123e4567-e89b-42d3-a456-426614174000";
const TENANT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const now = new Date("2026-10-28T00:00:00.000Z");

function signed(query: Record<string, string>): Record<string, string> {
  return { ...query, hmac: crypto.createHmac("sha256", SECRET).update(shopifyQueryMessage(query)).digest("hex") };
}

function res() {
  const r: any = { statusCode: 200, body: null, redirectedTo: null, headers: {} };
  r.status = (code: number) => { r.statusCode = code; return r; };
  r.json = (body: unknown) => { r.body = body; return r; };
  r.set = (key: string, value: string) => { r.headers[key] = value; return r; };
  r.redirect = (code: number, url: string) => { r.statusCode = code; r.redirectedTo = url; return r; };
  return r;
}

function grant(access = "access-1", refresh = "refresh-1", accessOffset = 86_400_000) {
  return {
    access_token: access,
    refresh_token: refresh,
    scopes: ["read_products", "read_orders"],
    access_token_expires_at: new Date(now.getTime() + accessOffset),
    refresh_token_expires_at: new Date(now.getTime() + 90 * 86_400_000),
  };
}

function pending(overrides: Record<string, unknown> = {}) {
  return {
    installation_id: INSTALLATION_ID,
    generation: 1,
    shop: "zavi-test-store.myshopify.com",
    ...grant(),
    composio_account_id: null,
    superseded_composio_account_ids: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubEnv("SHOPIFY_CLIENT_ID", "client-id");
  vi.stubEnv("SHOPIFY_CLIENT_SECRET", SECRET);
  vi.stubEnv("WEB_ORIGIN", "https://www.zaviagent.com");
  m.auth = { tenant_id: TENANT_ID, user_id: USER_ID, email: "owner@store.com" };
  m.managedConfig = false;
  m.configScheme = "BEARER_TOKEN";
  for (const fn of [m.consumeState, m.storePending, m.status, m.pending, m.reserve, m.rotate, m.acquireLease, m.releaseLease, m.setAccount,
    m.complete, m.exchange, m.refresh, m.lookupConfig, m.ensureToolkit, m.importBearer, m.patchBearer,
    m.verifyActive, m.verifyOwned, m.disconnect, m.storedAccount, m.saveShop, m.rpc, m.linkAppMember, m.linkAvailable, m.connectedTenant, m.adminRole]) fn.mockReset();
  m.connectedTenant.mockResolvedValue(TENANT_ID);
  m.adminRole.mockResolvedValue("owner");
  m.consumeState.mockResolvedValue(true);
  m.exchange.mockResolvedValue(grant());
  m.storePending.mockResolvedValue({ installation_id: INSTALLATION_ID, generation: 1 });
  m.status.mockResolvedValue({
    shop: "zavi-test-store.myshopify.com", composio_account_id: null,
    claimed_tenant_id: null, claimed_at: null, has_pending_grant: true,
  });
  m.pending.mockResolvedValue(pending());
  m.reserve.mockResolvedValue(true);
  m.rotate.mockResolvedValue(true);
  m.acquireLease.mockResolvedValue(true);
  m.releaseLease.mockResolvedValue(undefined);
  m.setAccount.mockResolvedValue(true);
  m.complete.mockResolvedValue(true);
  m.lookupConfig.mockResolvedValue("ac_shopify");
  m.ensureToolkit.mockResolvedValue({ toolsNotAdded: null });
  m.importBearer.mockResolvedValue({ connected_account_id: "ca_new" });
  m.verifyActive.mockImplementation(async (a: { connected_account_id: string }) => a.connected_account_id === "ca_new");
  m.verifyOwned.mockResolvedValue(false);
  m.storedAccount.mockResolvedValue(null);
  m.saveShop.mockResolvedValue(true);
  m.linkAppMember.mockResolvedValue(true);
  m.linkAvailable.mockResolvedValue(true);
  m.rpc.mockResolvedValue({ error: null });
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("Shopify OAuth callback", () => {
  it("stores the grant before showing any Zavi login and redirects with only an opaque reference", async () => {
    const r = res();
    await shopifyCallback({ query: signed({ shop: "zavi-test-store.myshopify.com", code: "code-1", state: "state-1" }) } as unknown as Request, r as Response);
    expect(m.consumeState).toHaveBeenCalledWith("zavi-test-store.myshopify.com", "state-1");
    expect(m.exchange).toHaveBeenCalledWith("zavi-test-store.myshopify.com", "code-1");
    expect(r.statusCode).toBe(302);
    const token = new URL(r.redirectedTo).searchParams.get("token");
    expect(verifyInstallToken(token)).toEqual({ installation_id: INSTALLATION_ID, generation: 1 });
    expect(token).not.toContain("zavi-test-store");
  });

  it("rejects a replayed state before exchanging the code", async () => {
    m.consumeState.mockResolvedValueOnce(false);
    const r = res();
    await shopifyCallback({ query: signed({ shop: "zavi-test-store.myshopify.com", code: "code-1", state: "used" }) } as unknown as Request, r as Response);
    expect(r.redirectedTo).toContain("error=invalid_state");
    expect(m.exchange).not.toHaveBeenCalled();
  });
});

describe("Shopify install claim", () => {
  const token = () => signInstallTokenForViewer(INSTALLATION_ID, 1, "owner@store.com");

  it("does not create a Zavi session implicitly", async () => {
    m.auth = null;
    const r = res();
    await shopifyInstallStatus({ query: { token: token() } } as unknown as Request, r as Response);
    expect(r.statusCode).toBe(401);
  });

  it("rejects a different Zavi email before reserving or claiming the store", async () => {
    m.auth = { tenant_id: TENANT_ID, user_id: USER_ID, email: "other@agency.com" };
    const r = res();
    await shopifyClaim({ body: { token: token() } } as unknown as Request, r as Response);
    expect(r.statusCode).toBe(403);
    expect(r.body.error.code).toBe("shopify_email_mismatch");
    expect(m.reserve).not.toHaveBeenCalled();
    expect(m.importBearer).not.toHaveBeenCalled();
  });

  it("does not reveal managed-install status to a different Zavi email", async () => {
    m.auth = { tenant_id: TENANT_ID, user_id: USER_ID, email: "other@agency.com" };
    const r = res();
    await shopifyInstallStatus({ query: { token: token() } } as unknown as Request, r as Response);
    expect(r.statusCode).toBe(403);
    expect(r.body.error.code).toBe("shopify_email_mismatch");
    expect(m.status).not.toHaveBeenCalled();
  });

  it("returns a completed install to the embedded app in Shopify admin", async () => {
    m.status.mockResolvedValueOnce({
      shop: "zavi-test-store.myshopify.com", composio_account_id: "ca_new",
      claimed_tenant_id: TENANT_ID, claimed_at: now.toISOString(), has_pending_grant: false,
    });
    const r = res();
    await shopifyInstallStatus({ query: { token: token() } } as unknown as Request, r as Response);
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatchObject({
      connected: true,
      redirect_url: "https://admin.shopify.com/store/zavi-test-store/apps/client-id",
    });
  });

  it("reserves the selected workspace and imports the Shopify access token into Composio without another OAuth", async () => {
    const r = res();
    await shopifyClaim({ body: { token: token() } } as unknown as Request, r as Response);
    expect(m.reserve).toHaveBeenCalledWith(expect.objectContaining({ installation_id: INSTALLATION_ID, generation: 1 }), TENANT_ID);
    expect(m.importBearer).toHaveBeenCalledWith(expect.objectContaining({
      user_id: TENANT_ID, auth_config_id: "ac_shopify", access_token: "access-1",
      connection_data: { subdomain: "zavi-test-store" },
    }));
    expect(m.importBearer.mock.calls[0][0]).not.toHaveProperty("refresh_token");
    expect(m.setAccount).toHaveBeenCalledWith(expect.objectContaining({ installation_id: INSTALLATION_ID, generation: 1 }), TENANT_ID, "ca_new", null);
    expect(m.complete).toHaveBeenCalledWith(expect.objectContaining({ installation_id: INSTALLATION_ID, generation: 1 }), TENANT_ID, "ca_new");
    expect(r.statusCode).toBe(200);
    expect(r.body.redirect_url).toBe("https://admin.shopify.com/store/zavi-test-store/apps/client-id");
  });

  it("keeps the workspace return for a classic OAuth install without a Shopify viewer binding", async () => {
    const r = res();
    await shopifyClaim({ body: { token: signInstallToken(INSTALLATION_ID, 1) } } as unknown as Request, r as Response);
    expect(r.statusCode).toBe(200);
    expect(r.body.redirect_url).toBe("/workspace?tab=brain&shopify=connected#integration");
    expect(m.linkAppMember).not.toHaveBeenCalled();
  });

  it("returns an App Home handoff to Shopify without requiring matching account emails", async () => {
    m.auth = { tenant_id: TENANT_ID, user_id: USER_ID, email: "reviewer-login@zaviagent.com" };
    const r = res();
    await shopifyClaim({ body: { token: signAppHomeInstallToken(INSTALLATION_ID, 1, "42") } } as unknown as Request, r as Response);
    expect(r.statusCode).toBe(200);
    const redirect = new URL(r.body.redirect_url);
    expect(`${redirect.origin}${redirect.pathname}`).toBe("https://admin.shopify.com/store/zavi-test-store/apps/client-id");
    expect(redirect.searchParams.get("zavi_confirmation")).toBeTruthy();
    expect(m.reserve).not.toHaveBeenCalled();
    expect(m.importBearer).not.toHaveBeenCalled();
    expect(m.linkAppMember).not.toHaveBeenCalled();
  });

  it("does not import an App Home grant when its Shopify staff identity belongs to another active workspace", async () => {
    m.linkAvailable.mockResolvedValueOnce(false);
    const r = res();
    const ref = verifyInstallToken(signAppHomeInstallToken(INSTALLATION_ID, 1, "42"))!;
    await finishShopifyClaim(ref, { tenant_id: TENANT_ID as TenantId, user_id: USER_ID, email: null }, r as Response);
    expect(r.statusCode).toBe(409);
    expect(r.body.error.code).toBe("shopify_identity_linked_elsewhere");
    expect(m.reserve).not.toHaveBeenCalled();
    expect(m.importBearer).not.toHaveBeenCalled();
    expect(m.complete).not.toHaveBeenCalled();
  });

  it("binds the confirmed Shopify staff identity before saving the connector", async () => {
    const r = res();
    const ref = verifyInstallToken(signAppHomeInstallToken(INSTALLATION_ID, 1, "42"))!;
    await finishShopifyClaim(ref, { tenant_id: TENANT_ID as TenantId, user_id: USER_ID, email: null }, r as Response);
    expect(r.statusCode).toBe(200);
    expect(m.linkAppMember).toHaveBeenCalledWith({
      tenant_id: TENANT_ID,
      shop: "zavi-test-store.myshopify.com",
      shopify_user_id: "42",
      user_id: USER_ID,
    });
    expect(m.linkAppMember.mock.invocationCallOrder[0]).toBeLessThan(m.rpc.mock.invocationCallOrder[0]);
    expect(m.complete).toHaveBeenCalled();
  });

  it("refreshes an access token after a long signup before importing it", async () => {
    m.pending.mockResolvedValue(pending({ access_token_expires_at: new Date(now.getTime() - 1_000) }));
    m.refresh.mockResolvedValueOnce(grant("access-2", "refresh-2"));
    const r = res();
    await shopifyClaim({ body: { token: token() } } as unknown as Request, r as Response);
    expect(m.refresh).toHaveBeenCalledWith("zavi-test-store.myshopify.com", "refresh-1");
    expect(m.rotate).toHaveBeenCalled();
    expect(m.importBearer).toHaveBeenCalledWith(expect.objectContaining({ access_token: "access-2" }));
    expect(m.importBearer.mock.calls[0][0]).not.toHaveProperty("refresh_token");
    expect(r.statusCode).toBe(200);
  });

  it("requires Shopify approval again only after the refresh token expires", async () => {
    m.pending.mockResolvedValueOnce(pending({
      access_token_expires_at: new Date(now.getTime() - 1_000),
      refresh_token_expires_at: new Date(now.getTime() - 1_000),
    }));
    const r = res();
    await shopifyClaim({ body: { token: token() } } as unknown as Request, r as Response);
    expect(r.statusCode).toBe(409);
    expect(r.body.error.code).toBe("shopify_reauthorization_required");
    expect(m.importBearer).not.toHaveBeenCalled();
  });

  it("makes a completed retry idempotent", async () => {
    m.status.mockResolvedValueOnce({
      shop: "zavi-test-store.myshopify.com", composio_account_id: "ca_new",
      claimed_tenant_id: TENANT_ID, claimed_at: now.toISOString(), has_pending_grant: false,
    });
    const r = res();
    await shopifyClaim({ body: { token: token() } } as unknown as Request, r as Response);
    expect(r.statusCode).toBe(200);
    expect(r.body.already_connected).toBe(true);
    expect(r.body.redirect_url).toBe("https://admin.shopify.com/store/zavi-test-store/apps/client-id");
    expect(m.reserve).not.toHaveBeenCalled();
    expect(m.importBearer).not.toHaveBeenCalled();
  });

  it("keeps the replaced account reachable for retry cleanup", async () => {
    m.storedAccount.mockResolvedValueOnce("ca_old");
    const r = res();
    await shopifyClaim({ body: { token: token() } } as unknown as Request, r as Response);
    expect(m.setAccount).toHaveBeenCalledWith(
      expect.objectContaining({ installation_id: INSTALLATION_ID, generation: 1 }),
      TENANT_ID,
      "ca_new",
      "ca_old",
    );
    expect(m.disconnect).toHaveBeenCalledWith("ca_old");
    expect(r.statusCode).toBe(200);
  });

  it("refuses to import the grant into a Composio-managed Shopify config", async () => {
    m.managedConfig = true;
    try {
      const r = res();
      await shopifyClaim({ body: { token: token() } } as unknown as Request, r as Response);
      expect(r.statusCode).toBe(503);
      expect(r.body.error.code).toBe("shopify_auth_config_not_bearer");
      expect(m.importBearer).not.toHaveBeenCalled();
    } finally {
      m.managedConfig = false;
    }
  });

  it("refuses a custom OAuth config because only BEARER_TOKEN can preserve the one-consent flow", async () => {
    m.configScheme = "OAUTH2";
    const r = res();
    await shopifyClaim({ body: { token: token() } } as unknown as Request, r as Response);
    expect(r.statusCode).toBe(503);
    expect(r.body.error.code).toBe("shopify_auth_config_not_bearer");
    expect(m.importBearer).not.toHaveBeenCalled();
  });

  it("revokes an imported account that is not ACTIVE for the exact workspace and config", async () => {
    m.verifyActive.mockResolvedValue(false);
    const r = res();
    await shopifyClaim({ body: { token: token() } } as unknown as Request, r as Response);
    expect(m.verifyActive).toHaveBeenCalledWith({ user_id: TENANT_ID, auth_config_id: "ac_shopify", connected_account_id: "ca_new" });
    expect(m.disconnect).toHaveBeenCalledWith("ca_new");
    expect(m.setAccount).not.toHaveBeenCalled();
    expect(m.complete).not.toHaveBeenCalled();
    expect(r.statusCode).toBe(502);
  });

  it("revokes the imported account when the ACTIVE check itself fails", async () => {
    m.verifyActive.mockRejectedValue(new Error("composio HTTP 500"));
    const r = res();
    await shopifyClaim({ body: { token: token() } } as unknown as Request, r as Response);
    expect(m.disconnect).toHaveBeenCalledWith("ca_new");
    expect(m.setAccount).not.toHaveBeenCalled();
    expect(r.statusCode).toBe(502);
  });

  it("holds the per-store refresh lease around a Shopify refresh and releases it after", async () => {
    const now = new Date();
    m.pending.mockResolvedValue(pending({ access_token_expires_at: new Date(now.getTime() - 1_000) }));
    m.refresh.mockResolvedValue(grant("access-2", "refresh-2"));
    const r = res();
    await shopifyClaim({ body: { token: token() } } as unknown as Request, r as Response);
    expect(m.acquireLease).toHaveBeenCalledWith(expect.objectContaining({ installation_id: INSTALLATION_ID, generation: 1 }));
    expect(m.refresh).toHaveBeenCalledTimes(1);
    expect(m.releaseLease).toHaveBeenCalledWith(expect.objectContaining({ installation_id: INSTALLATION_ID, generation: 1 }));
    expect(r.statusCode).toBe(200);
  });

  it("never sends Shopify a second refresh while another refresher holds the lease", async () => {
    const now = new Date();
    m.pending.mockResolvedValue(pending({ access_token_expires_at: new Date(now.getTime() - 1_000) }));
    m.acquireLease.mockResolvedValue(false);
    const r = res();
    await shopifyClaim({ body: { token: token() } } as unknown as Request, r as Response);
    expect(m.refresh).not.toHaveBeenCalled();
    expect(m.importBearer).not.toHaveBeenCalled();
    expect(r.statusCode).toBe(502);
  });

  it("repairs a retry by PATCHing the current token into the already-owned pending account", async () => {
    m.pending.mockResolvedValueOnce(pending({ composio_account_id: "ca_retry" }));
    m.verifyOwned.mockResolvedValueOnce(true);
    m.verifyActive.mockResolvedValueOnce(true);
    const r = res();
    await shopifyClaim({ body: { token: token() } } as unknown as Request, r as Response);
    expect(m.patchBearer).toHaveBeenCalledWith({ connected_account_id: "ca_retry", access_token: "access-1" });
    expect(m.importBearer).not.toHaveBeenCalled();
    expect(m.complete).toHaveBeenCalledWith(expect.objectContaining({ installation_id: INSTALLATION_ID, generation: 1 }), TENANT_ID, "ca_retry");
    expect(r.statusCode).toBe(200);
  });

  it("fails closed without importing or deleting when a pending account is outside the exact workspace scope", async () => {
    m.pending.mockResolvedValueOnce(pending({ composio_account_id: "ca_unowned" }));
    m.verifyOwned.mockResolvedValueOnce(false);
    const r = res();
    await shopifyClaim({ body: { token: token() } } as unknown as Request, r as Response);
    expect(r.statusCode).toBe(502);
    expect(m.importBearer).not.toHaveBeenCalled();
    expect(m.patchBearer).not.toHaveBeenCalled();
    expect(m.disconnect).not.toHaveBeenCalledWith("ca_unowned");
  });

  it("cannot be claimed by a second workspace", async () => {
    m.status.mockResolvedValueOnce({
      shop: "zavi-test-store.myshopify.com", composio_account_id: null,
      claimed_tenant_id: "T2", claimed_at: null, has_pending_grant: true,
    });
    const r = res();
    await shopifyClaim({ body: { token: token() } } as unknown as Request, r as Response);
    expect(r.statusCode).toBe(409);
    expect(r.body.error.code).toBe("install_already_claimed");
    expect(m.importBearer).not.toHaveBeenCalled();
  });
});

describe("Shopify staff link for a store that is already connected", () => {
  const SHOP = "zavi-test-store.myshopify.com";
  const OTHER_TENANT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const linkToken = () => signShopifyAppLinkToken(SHOP, "123", SECRET);

  it("names the connected workspace to its owner or admin without reading any install", async () => {
    m.auth = { tenant_id: OTHER_TENANT, user_id: USER_ID, email: "different@zavi.test" };
    const r = res();
    await shopifyInstallStatus({ query: { token: linkToken() } } as unknown as Request, r as Response);
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ shop: SHOP, connected: false, claimed_elsewhere: false, link_tenant_id: TENANT_ID });
    expect(m.adminRole).toHaveBeenCalledWith(TENANT_ID, USER_ID);
    expect(m.status).not.toHaveBeenCalled();
  });

  it("hands a signed link choice back to Shopify and writes nothing", async () => {
    const r = res();
    await shopifyClaim({ body: { token: linkToken() } } as Request, r as Response);
    expect(r.statusCode).toBe(200);
    const confirmation = new URL(r.body.redirect_url).searchParams.get("zavi_confirmation");
    expect(verifyShopifyAppLinkConfirmation(confirmation, SECRET)).toEqual({
      shop: SHOP, shopify_user_id: "123", tenant_id: TENANT_ID, user_id: USER_ID,
    });
    expect(m.linkAppMember).not.toHaveBeenCalled();
    expect(m.reserve).not.toHaveBeenCalled();
    expect(m.importBearer).not.toHaveBeenCalled();
  });

  it("refuses a Zavi user who is not an owner or admin of the connected workspace", async () => {
    m.adminRole.mockResolvedValue(null);
    const status = res();
    await shopifyInstallStatus({ query: { token: linkToken() } } as unknown as Request, status as Response);
    expect(status.statusCode).toBe(403);
    expect(status.body.link_tenant_id).toBeUndefined();
    const claim = res();
    await shopifyClaim({ body: { token: linkToken() } } as Request, claim as Response);
    expect(claim.statusCode).toBe(403);
    expect(claim.body.error.code).toBe("connector_admin_required");
    expect(claim.body.redirect_url).toBeUndefined();
  });

  it("refuses when the store is no longer connected to exactly one workspace", async () => {
    for (const connected of [null, "ambiguous"]) {
      m.connectedTenant.mockResolvedValue(connected);
      const r = res();
      await shopifyClaim({ body: { token: linkToken() } } as Request, r as Response);
      expect(r.statusCode).toBe(410);
    }
    expect(m.adminRole).not.toHaveBeenCalled();
  });

  it("refuses a staff identity already linked to another active workspace", async () => {
    m.linkAvailable.mockResolvedValue(false);
    const r = res();
    await shopifyClaim({ body: { token: linkToken() } } as Request, r as Response);
    expect(r.statusCode).toBe(409);
    expect(r.body.error.code).toBe("shopify_identity_linked_elsewhere");
  });
});
