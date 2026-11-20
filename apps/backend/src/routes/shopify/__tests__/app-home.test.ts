import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const m = vi.hoisted(() => ({
  context: vi.fn(),
  decisionRow: vi.fn(),
  decide: vi.fn(),
  verifySession: vi.fn(),
  onlineGrant: vi.fn(),
  offlineGrant: vi.fn(),
  storePending: vi.fn(),
  signAppHome: vi.fn(),
  verifyConfirmation: vi.fn(),
  finishClaim: vi.fn(),
  membership: vi.fn(),
  tenant: vi.fn(),
  userEmail: vi.fn(),
  disabled: vi.fn(),
  installStatus: vi.fn(),
  connectedTenant: vi.fn(),
  signLink: vi.fn(),
  verifyLinkConfirmation: vi.fn(),
  linkMember: vi.fn(),
  linkAvailable: vi.fn(),
}));

vi.mock("@/routes/connectors/shopify", () => ({ finishShopifyClaim: m.finishClaim }));

vi.mock("@/services/connectors/shopify/app-context", () => ({
  ShopifyAppContextError: class ShopifyAppContextError extends Error {},
  resolveShopifyAppContext: m.context,
}));
vi.mock("@/services/approvals/decide-service", () => ({ decideOnDecision: m.decide }));
vi.mock("@/services/connectors/shopify/session", () => ({
  ShopifySessionError: class ShopifySessionError extends Error {
    constructor(readonly code: string) { super(code); }
  },
  verifyShopifyIdToken: m.verifySession,
  exchangeShopifyOnlineToken: m.onlineGrant,
  exchangeShopifyOfflineToken: m.offlineGrant,
}));
vi.mock("@/services/connectors/shopify/store", () => ({ connectedTenantForShop: m.connectedTenant }));
vi.mock("@/services/connectors/shopify/app-identity", () => ({
  linkShopifyAppMember: m.linkMember,
  shopifyAppMemberLinkAvailable: m.linkAvailable,
  shopifyWorkspaceAdminRole: m.membership,
}));
vi.mock("@/services/connectors/shopify/pending-install", () => ({
  storePendingShopifyInstall: m.storePending,
  getShopifyInstallStatus: m.installStatus,
}));
vi.mock("@/services/connectors/shopify/hmac", () => ({
  signAppHomeInstallToken: m.signAppHome,
  signShopifyAppLinkToken: m.signLink,
  verifyShopifyAppHomeConfirmation: m.verifyConfirmation,
  verifyShopifyAppLinkConfirmation: m.verifyLinkConfirmation,
}));
vi.mock("@/services/tenants/disabled", () => ({ readTenantDisabled: m.disabled }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (id: string) => id,
  readShopifyConfirmationUserEmail: m.userEmail,
  tenantClient: () => ({
    from: (table: string) => ({
      select: () => {
        const result = table === "tenants" ? m.tenant : m.decisionRow;
        return { maybeSingle: result, eq: () => ({ maybeSingle: result }) };
      },
    }),
  }),
}));

import { shopifyAppHomeBillingAuth, shopifyAppHomeDecide, shopifyAppHomeInstall, shopifyAppHomeInstallConfirm, shopifyAppHomeInstallConfirmation } from "../app-home";

const DECISION_ID = "123e4567-e89b-42d3-a456-426614174000";

function response() {
  const out: any = { statusCode: 200, body: null, headers: {} };
  out.status = (statusCode: number) => { out.statusCode = statusCode; return out; };
  out.json = (body: unknown) => { out.body = body; return out; };
  out.set = (name: string, value: string) => { out.headers[name] = value; return out; };
  return out;
}

function request(decision: "approve" | "reject" = "approve") {
  return {
    params: { decision_id: DECISION_ID },
    body: { decision },
    headers: { authorization: "Bearer signed-token" },
  } as unknown as Request;
}

beforeEach(() => {
  m.context.mockReset();
  m.decisionRow.mockReset();
  m.decide.mockReset();
  m.verifySession.mockReset();
  m.onlineGrant.mockReset();
  m.offlineGrant.mockReset();
  m.storePending.mockReset();
  m.signAppHome.mockReset();
  m.verifyConfirmation.mockReset();
  m.finishClaim.mockReset();
  m.membership.mockReset();
  m.tenant.mockReset();
  m.userEmail.mockReset();
  m.disabled.mockReset();
  m.installStatus.mockReset();
  m.connectedTenant.mockReset();
  m.signLink.mockReset();
  m.verifyLinkConfirmation.mockReset();
  m.linkMember.mockReset();
  m.linkAvailable.mockReset();
  m.connectedTenant.mockResolvedValue(null);
  m.signLink.mockReturnValue("signed-link-token");
  m.verifyLinkConfirmation.mockReturnValue(null);
  m.linkMember.mockResolvedValue(true);
  m.linkAvailable.mockResolvedValue(true);
  m.context.mockResolvedValue({
    shop: "zavi-test-store.myshopify.com",
    tenant_id: "tenant-1",
    user_id: "user-1",
    role: "member",
  });
  m.decisionRow.mockResolvedValue({
    data: { decision_class: "channel.recipe_step", body: {}, status: "proposed" },
    error: null,
  });
  m.decide.mockResolvedValue({ ok: true, changed: true });
  m.verifySession.mockResolvedValue({ token: "signed-session", shop: "zavi-test-store.myshopify.com", shopify_user_id: "123" });
  m.onlineGrant.mockResolvedValue({ associated_user: { email: "owner@store.com", email_verified: true } });
  m.offlineGrant.mockResolvedValue({
    access_token: "offline-access",
    refresh_token: "offline-refresh",
    scopes: ["read_products"],
    access_token_expires_at: new Date("2026-11-03T12:00:00Z"),
    refresh_token_expires_at: new Date("2027-02-01T12:00:00Z"),
  });
  m.storePending.mockResolvedValue({ installation_id: "123e4567-e89b-42d3-a456-426614174000", generation: 2 });
  m.signAppHome.mockReturnValue("signed-install-token");
  m.verifyConfirmation.mockReturnValue({
    ref: { installation_id: DECISION_ID, generation: 2, return_to_app: true, shopify_user_id: "123" },
    tenant_id: "tenant-1",
    user_id: "user-1",
  });
  m.membership.mockResolvedValue("owner");
  m.tenant.mockResolvedValue({ data: { display_name: "Zavi Test Store" }, error: null });
  m.userEmail.mockResolvedValue("owner@zavi.test");
  m.disabled.mockResolvedValue(false);
  m.installStatus.mockResolvedValue({ shop: "zavi-test-store.myshopify.com" });
});

describe("Shopify managed-install workspace handoff", () => {
  it("uses the signed Shopify session to store an offline grant and returns the existing claim page", async () => {
    const res = response();
    await shopifyAppHomeInstall({ headers: { authorization: "Bearer signed-session" } } as Request, res as Response);
    expect(res.statusCode).toBe(200);
    expect(m.verifySession).toHaveBeenCalledWith("Bearer signed-session");
    expect(m.onlineGrant).not.toHaveBeenCalled();
    expect(m.offlineGrant).toHaveBeenCalledWith(expect.objectContaining({ shop: "zavi-test-store.myshopify.com" }));
    expect(m.storePending).toHaveBeenCalledWith("zavi-test-store.myshopify.com", expect.objectContaining({ access_token: "offline-access" }));
    expect(m.signAppHome).toHaveBeenCalledWith("123e4567-e89b-42d3-a456-426614174000", 2, "123");
    expect(res.body.connect_url).toBe("http://localhost:3000/connectors/shopify/install?token=signed-install-token");
    expect(res.headers["Cache-Control"]).toBe("private, no-store");
  });

  it("does not block review staff whose Shopify email is unverified or differs from the Zavi test login", async () => {
    m.onlineGrant.mockResolvedValueOnce({ associated_user: { email: "owner@store.com", email_verified: false } });
    const res = response();
    await shopifyAppHomeInstall({ headers: { authorization: "Bearer signed-session" } } as Request, res as Response);
    expect(res.statusCode).toBe(200);
    expect(m.onlineGrant).not.toHaveBeenCalled();
    expect(m.offlineGrant).toHaveBeenCalled();
    expect(m.storePending).toHaveBeenCalled();
    expect(m.signAppHome).toHaveBeenCalled();
  });

  it("hands an already connected store to the staff link flow without minting a second grant", async () => {
    m.connectedTenant.mockResolvedValue("tenant-1");
    const res = response();
    await shopifyAppHomeInstall({ headers: { authorization: "Bearer signed-session" } } as Request, res as Response);
    expect(res.statusCode).toBe(200);
    expect(m.signLink).toHaveBeenCalledWith("zavi-test-store.myshopify.com", "123");
    expect(res.body.connect_url).toBe("http://localhost:3000/connectors/shopify/install?token=signed-link-token");
    expect(res.headers["Cache-Control"]).toBe("private, no-store");
    expect(m.offlineGrant).not.toHaveBeenCalled();
    expect(m.storePending).not.toHaveBeenCalled();
  });

  it("refuses a store connected to more than one workspace", async () => {
    m.connectedTenant.mockResolvedValue("ambiguous");
    const res = response();
    await shopifyAppHomeInstall({ headers: { authorization: "Bearer signed-session" } } as Request, res as Response);
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe("shop_ambiguous");
    expect(m.signLink).not.toHaveBeenCalled();
    expect(m.offlineGrant).not.toHaveBeenCalled();
  });

  it("fails closed when the existing-connection lookup is unavailable", async () => {
    m.connectedTenant.mockRejectedValue(new Error("db down"));
    const res = response();
    await shopifyAppHomeInstall({ headers: { authorization: "Bearer signed-session" } } as Request, res as Response);
    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe("shopify_install_unavailable");
    expect(m.offlineGrant).not.toHaveBeenCalled();
  });
});

describe("Shopify managed-install confirmation", () => {
  it("previews the exact workspace and account without importing the grant", async () => {
    const res = response();
    await shopifyAppHomeInstallConfirmation({
      headers: { authorization: "Bearer fresh-shopify-session" },
      body: { confirmation: "signed-choice" },
    } as Request, res as Response);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      shop: "zavi-test-store.myshopify.com",
      workspace: { display_name: "Zavi Test Store", account_email: "owner@zavi.test", role: "owner" },
      link_only: false,
    });
    expect(res.headers["Cache-Control"]).toBe("private, no-store");
    expect(m.finishClaim).not.toHaveBeenCalled();
  });

  it("finishes only after the fresh Shopify staff session matches the workspace choice", async () => {
    const res = response();
    await shopifyAppHomeInstallConfirm({
      headers: { authorization: "Bearer fresh-shopify-session" },
      body: { confirmation: "signed-choice" },
    } as Request, res as Response);
    expect(m.verifySession).toHaveBeenCalledWith("Bearer fresh-shopify-session");
    expect(m.finishClaim).toHaveBeenCalledWith(
      expect.objectContaining({ shopify_user_id: "123" }),
      { tenant_id: "tenant-1", user_id: "user-1", email: null },
      res,
    );
  });

  it("refuses a different Shopify staff session before any grant is imported", async () => {
    m.verifySession.mockResolvedValueOnce({ shop: "zavi-test-store.myshopify.com", shopify_user_id: "999" });
    const res = response();
    await shopifyAppHomeInstallConfirm({
      headers: { authorization: "Bearer other-shopify-session" },
      body: { confirmation: "signed-choice" },
    } as Request, res as Response);
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe("confirmation_mismatch");
    expect(m.finishClaim).not.toHaveBeenCalled();
  });
});

describe("Shopify staff link confirmation for a connected store", () => {
  const confirm = (res: ReturnType<typeof response>) => shopifyAppHomeInstallConfirm({
    headers: { authorization: "Bearer fresh-shopify-session" },
    body: { confirmation: "signed-link-choice" },
  } as Request, res as Response);

  beforeEach(() => {
    m.verifyConfirmation.mockReturnValue(null);
    m.verifyLinkConfirmation.mockReturnValue({
      shop: "zavi-test-store.myshopify.com",
      shopify_user_id: "123",
      tenant_id: "tenant-1",
      user_id: "user-1",
    });
    m.connectedTenant.mockResolvedValue("tenant-1");
  });

  it("previews the link without writing it", async () => {
    const res = response();
    await shopifyAppHomeInstallConfirmation({
      headers: { authorization: "Bearer fresh-shopify-session" },
      body: { confirmation: "signed-link-choice" },
    } as Request, res as Response);
    expect(res.statusCode).toBe(200);
    expect(res.body.link_only).toBe(true);
    expect(res.body.workspace.display_name).toBe("Zavi Test Store");
    expect(m.linkMember).not.toHaveBeenCalled();
  });

  it("only links the staff member and never runs the install claim", async () => {
    const res = response();
    await confirm(res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, linked: true });
    expect(m.linkMember).toHaveBeenCalledWith({
      tenant_id: "tenant-1",
      shop: "zavi-test-store.myshopify.com",
      shopify_user_id: "123",
      user_id: "user-1",
    });
    expect(m.finishClaim).not.toHaveBeenCalled();
    expect(m.installStatus).not.toHaveBeenCalled();
  });

  it("refuses a different Shopify staff session", async () => {
    m.verifySession.mockResolvedValueOnce({ shop: "zavi-test-store.myshopify.com", shopify_user_id: "999" });
    const res = response();
    await confirm(res);
    expect(res.statusCode).toBe(403);
    expect(m.linkMember).not.toHaveBeenCalled();
  });

  it("refuses a different store or a store that moved to another workspace", async () => {
    m.verifySession.mockResolvedValueOnce({ shop: "other-store.myshopify.com", shopify_user_id: "123" });
    const otherStore = response();
    await confirm(otherStore);
    expect(otherStore.statusCode).toBe(403);

    m.connectedTenant.mockResolvedValue("tenant-2");
    const moved = response();
    await confirm(moved);
    expect(moved.statusCode).toBe(403);
    expect(m.linkMember).not.toHaveBeenCalled();
  });

  it("refuses a Zavi user who is no longer an owner or admin", async () => {
    m.membership.mockResolvedValue(null);
    const res = response();
    await confirm(res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe("connector_admin_required");
    expect(m.linkMember).not.toHaveBeenCalled();
  });

  it("refuses a staff identity already linked to another active workspace", async () => {
    m.linkAvailable.mockResolvedValue(false);
    const res = response();
    await confirm(res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe("shopify_identity_linked_elsewhere");
    expect(m.linkMember).not.toHaveBeenCalled();
  });
});

describe("Shopify App Home approval route", () => {
  it("derives tenant and actor from Shopify auth instead of accepting either from the browser", async () => {
    const res = response();
    await shopifyAppHomeDecide(request("reject"), res as Response);
    expect(res.statusCode).toBe(200);
    expect(m.decide).toHaveBeenCalledWith({
      decision_id: DECISION_ID,
      tenant_id: "tenant-1",
      action: "reject",
      actor: { user_id: "user-1" },
      surface: "web",
      offer_run_alone: false,
    });
  });

  it("refuses every inline decision for a viewer", async () => {
    m.context.mockResolvedValue({ tenant_id: "tenant-1", user_id: "viewer-1", role: "viewer" });
    const res = response();
    await shopifyAppHomeDecide(request(), res as Response);
    expect(res.statusCode).toBe(403);
    expect(m.decisionRow).not.toHaveBeenCalled();
    expect(m.decide).not.toHaveBeenCalled();
  });

  it("returns forbidden when the decision service rejects the member's authority", async () => {
    m.decide.mockResolvedValue({ ok: false, code: "not_authorized", detail: "Owner approval is required." });
    const res = response();
    await shopifyAppHomeDecide(request(), res as Response);
    expect(res.statusCode).toBe(403);
  });

  it("sends money-changing work to the full Zavi review even for an owner", async () => {
    m.context.mockResolvedValue({ tenant_id: "tenant-1", user_id: "owner-1", role: "owner" });
    m.decisionRow.mockResolvedValue({
      data: {
        decision_class: "meta_ads.update_ad_set_budget",
        body: { daily_budget_usd: 50, expected_current_daily_budget_usd: 20 },
        status: "proposed",
      },
      error: null,
    });
    const res = response();
    await shopifyAppHomeDecide(request(), res as Response);
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe("full_review_required");
    expect(m.decide).not.toHaveBeenCalled();
  });

  it("sends social publishing to the full Zavi review", async () => {
    m.context.mockResolvedValue({ tenant_id: "tenant-1", user_id: "owner-1", role: "owner" });
    m.decisionRow.mockResolvedValue({
      data: { decision_class: "social.publish.v2", body: { post_draft: { text: "edited" } }, status: "proposed" },
      error: null,
    });
    const res = response();
    await shopifyAppHomeDecide(request(), res as Response);
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe("full_review_required");
    expect(m.decide).not.toHaveBeenCalled();
  });
});

describe("Shopify App Home billing pre-auth", () => {
  it("passes only a linked owner/admin identity into the idempotency scope", async () => {
    m.context.mockResolvedValue({ tenant_id: "tenant-1", user_id: "owner-1", role: "owner" });
    const req = request();
    const res = response();
    const next = vi.fn();
    await shopifyAppHomeBillingAuth(req, res as Response, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.idempotencyScope).toEqual({ tenant_id: "tenant-1", user_id: "owner-1" });
    expect(req.shopifyAppContext).toMatchObject({ role: "owner" });
  });

  it("refuses a viewer before creating an idempotency claim", async () => {
    m.context.mockResolvedValue({ tenant_id: "tenant-1", user_id: "viewer-1", role: "viewer" });
    const req = request();
    const res = response();
    const next = vi.fn();
    await shopifyAppHomeBillingAuth(req, res as Response, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
    expect(req.idempotencyScope).toBeUndefined();
  });
});
