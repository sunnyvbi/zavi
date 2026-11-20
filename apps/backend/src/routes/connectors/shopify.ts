import crypto from "node:crypto";
import type { Request, Response } from "express";
import { requireAuth, type AuthedRequest } from "@/services/auth/middleware";
import { asTenantId, tenantRpc } from "@/services/tenant-client";
import { buildComposioMcpUrl } from "@/services/connectors/composio/api-key";
import { ensureToolkitOnMcpServer, lookupAuthConfigId } from "@/services/connectors/composio/catalog";
import {
  authConfigSupportsBearerImport,
  composioDisconnect,
  composioGetAuthConfig,
  composioImportBearerToken,
  composioPatchBearerToken,
  composioVerifyActive,
  composioVerifyOwned,
} from "@/services/connectors/composio/api";
import { storedComposioAccount } from "@/services/connectors/composio/connection-row";
import { recordConnectorEvent } from "@/services/connectors/core/connector-events";
import {
  normalizeShopDomain,
  shopifyEnabled,
  shopifyClientId,
  shopSubdomain,
  installTokenMatchesViewerEmail,
  signShopifyAppHomeConfirmation,
  signShopifyAppLinkConfirmation,
  signInstallToken,
  verifyInstallToken,
  verifyShopifyAppLinkToken,
  verifyShopifyQueryHmac,
  type ShopifyAppLinkRef,
} from "@/services/connectors/shopify/hmac";
import {
  acquireShopifyRefreshLease,
  completePendingShopifyInstall,
  consumeShopifyOAuthState,
  getPendingShopifyInstall,
  getShopifyInstallStatus,
  mintShopifyOAuthState,
  persistRotatedShopifyGrant,
  releaseShopifyRefreshLease,
  reservePendingShopifyInstall,
  setPendingComposioAccount,
  storePendingShopifyInstall,
} from "@/services/connectors/shopify/pending-install";
import { installErrorUrl, installLandingUrl } from "@/services/connectors/shopify/install-url";
import { exchangeShopifyCode, refreshShopifyGrant, ShopifyOAuthError, shopifyAuthorizeUrl } from "@/services/connectors/shopify/oauth";
import { connectedTenantForShop, connectionsForShop, saveShopDomain } from "@/services/connectors/shopify/store";
import { linkShopifyAppMember, shopifyAppMemberLinkAvailable, shopifyWorkspaceAdminRole } from "@/services/connectors/shopify/app-identity";
import { logEvent } from "@/services/logging/logEvent";
import { notifyFounderActivity } from "@/services/tenants/founder-activity-alert";

const TIMESTAMP_SKEW_MS = 24 * 60 * 60 * 1000;
const REFRESH_EARLY_MS = 5 * 60 * 1000;
const TOOLKIT = "shopify";
const CONNECTED_WORKSPACE_URL = "/workspace?tab=brain&shopify=connected#integration";

function webOrigin(): string {
  return (process.env.WEB_ORIGIN || "http://localhost:3000").split(",")[0].trim();
}

export function shopifyAppHomeUrl(query: Record<string, unknown>, origin: string = webOrigin()): string {
  const url = new URL("/shopify/app-home", origin);
  for (const key of ["shop", "host", "embedded"] as const) {
    const value = query[key];
    if (typeof value === "string") url.searchParams.set(key, value);
  }
  return url.toString();
}

export function shopifyAdminAppUrl(shop: string): string {
  return `https://admin.shopify.com/store/${encodeURIComponent(shopSubdomain(shop))}/apps/${encodeURIComponent(shopifyClientId())}`;
}

export function shopifyAdminAppConfirmationUrl(shop: string, confirmation: string): string {
  const url = new URL(shopifyAdminAppUrl(shop));
  url.searchParams.set("zavi_confirmation", confirmation);
  return url.toString();
}

function installCompletionUrl(ref: NonNullable<ReturnType<typeof verifyInstallToken>>, email: string | null, shop: string): string {
  return ref.return_to_app || installTokenMatchesViewerEmail(ref, email)
    ? shopifyAdminAppUrl(shop)
    : CONNECTED_WORKSPACE_URL;
}

function rejectViewerEmailMismatch(
  ref: NonNullable<ReturnType<typeof verifyInstallToken>>,
  email: string | null,
  res: Response,
): boolean {
  if (!ref.viewer_email_fingerprint || installTokenMatchesViewerEmail(ref, email)) return false;
  res.status(403).json({
    error: {
      code: "shopify_email_mismatch",
      message: "Sign in to Zavi using the same verified email as this Shopify staff account.",
    },
  });
  return true;
}

async function shopHasZaviConnection(shop: string): Promise<boolean> {
  return (await connectionsForShop(shop)).length > 0;
}

export async function shopifyInstall(req: Request, res: Response): Promise<void> {
  if (!shopifyEnabled()) {
    res.status(503).json({ error: { code: "shopify_not_configured", message: "Shopify install is not configured." } });
    return;
  }
  const query = req.query as Record<string, unknown>;
  if (!verifyShopifyQueryHmac(query)) {
    void logEvent({ level: "warn", source: "shopify.install", code: "shopify_install_bad_hmac" });
    res.status(401).json({ error: { code: "invalid_signature", message: "This request did not come from Shopify." } });
    return;
  }
  const shop = normalizeShopDomain(query.shop);
  if (!shop) {
    res.status(400).json({ error: { code: "invalid_shop", message: "Missing or invalid shop." } });
    return;
  }
  const ts = Number(query.timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts * 1000) > TIMESTAMP_SKEW_MS) {
    res.status(401).json({ error: { code: "stale_request", message: "This install link has expired. Open Zavi from your Shopify admin again." } });
    return;
  }

  let connected: boolean;
  try {
    connected = await shopHasZaviConnection(shop);
  } catch (e) {
    void logEvent({ level: "error", source: "shopify.install", code: "shopify_install_lookup_failed", message: (e as Error).message });
    res.status(503).json({ error: { code: "shopify_install_unavailable", message: "Could not check this Shopify installation. Try again." } });
    return;
  }
  if (connected) {
    res.redirect(302, String(query.embedded ?? "") === "1" ? shopifyAppHomeUrl(query) : shopifyAdminAppUrl(shop));
    return;
  }

  const state = crypto.randomBytes(32).toString("base64url");
  try {
    await mintShopifyOAuthState(shop, state);
    res.redirect(302, shopifyAuthorizeUrl(shop, state));
  } catch (e) {
    void logEvent({ level: "error", source: "shopify.install", code: "shopify_oauth_start_failed", message: (e as Error).message });
    res.status(503).json({ error: { code: "shopify_oauth_unavailable", message: "Could not start Shopify authorization. Try again." } });
  }
}

function callbackFailure(res: Response, code: string): void {
  res.redirect(302, installErrorUrl(code));
}

export async function shopifyCallback(req: Request, res: Response): Promise<void> {
  if (!shopifyEnabled()) return callbackFailure(res, "shopify_not_configured");
  const query = req.query as Record<string, unknown>;
  if (!verifyShopifyQueryHmac(query)) return callbackFailure(res, "invalid_signature");
  const shop = normalizeShopDomain(query.shop);
  const code = typeof query.code === "string" ? query.code.trim() : "";
  const state = typeof query.state === "string" ? query.state.trim() : "";
  if (!shop || !code || !state) return callbackFailure(res, "invalid_callback");

  let stateValid = false;
  try {
    stateValid = await consumeShopifyOAuthState(shop, state);
  } catch (e) {
    void logEvent({ level: "error", source: "shopify.install", code: "shopify_state_consume_failed", message: (e as Error).message });
    return callbackFailure(res, "state_unavailable");
  }
  if (!stateValid) return callbackFailure(res, "invalid_state");

  try {
    const grant = await exchangeShopifyCode(shop, code);
    const pending = await storePendingShopifyInstall(shop, grant);
    const token = signInstallToken(pending.installation_id, pending.generation);
    res.set("Referrer-Policy", "no-referrer");
    res.redirect(302, installLandingUrl(token));
  } catch (e) {
    const code = e instanceof ShopifyOAuthError ? e.code : "install_store_failed";
    void logEvent({ level: "error", source: "shopify.install", code: `shopify_${code}`, message: (e as Error).message });
    callbackFailure(res, code);
  }
}

async function shopifyStaffLinkTenant(
  link: ShopifyAppLinkRef,
  auth: Pick<AuthedRequest, "user_id">,
  res: Response,
): Promise<string | null> {
  const tenantId = await connectedTenantForShop(link.shop);
  if (!tenantId || tenantId === "ambiguous") {
    res.status(410).json({ error: { code: "install_not_found", message: "This store is no longer connected to one Zavi workspace. Open Zavi from Shopify to restart." } });
    return null;
  }
  if (!(await shopifyWorkspaceAdminRole(tenantId, auth.user_id))) {
    res.status(403).json({
      error: {
        code: "connector_admin_required",
        message: "Sign in to Zavi as an owner or admin of the workspace connected to this store to link this Shopify staff account.",
      },
    });
    return null;
  }
  return tenantId;
}

export async function shopifyInstallStatus(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const link = verifyShopifyAppLinkToken(req.query.token);
  if (link) {
    try {
      const tenantId = await shopifyStaffLinkTenant(link, auth, res);
      if (tenantId) res.status(200).json({ shop: link.shop, connected: false, claimed_elsewhere: false, link_tenant_id: tenantId });
    } catch {
      res.status(503).json({ error: { code: "install_status_unavailable", message: "Could not load this Shopify installation. Try again." } });
    }
    return;
  }
  const ref = verifyInstallToken(req.query.token);
  if (!ref) {
    res.status(400).json({ error: { code: "invalid_install", message: "This Shopify installation link is invalid or expired. Open Zavi from Shopify to restart it." } });
    return;
  }
  if (rejectViewerEmailMismatch(ref, auth.email, res)) return;
  try {
    const status = await getShopifyInstallStatus(ref);
    if (!status) {
      res.status(410).json({ error: { code: "install_not_found", message: "This Shopify installation is no longer available. Open Zavi from Shopify to restart it." } });
      return;
    }
    const connected = status.claimed_at !== null && !status.has_pending_grant && status.claimed_tenant_id === auth.tenant_id;
    res.status(200).json({
      shop: status.shop,
      connected,
      claimed_elsewhere: status.claimed_tenant_id !== null && status.claimed_tenant_id !== auth.tenant_id,
      ...(connected ? { redirect_url: installCompletionUrl(ref, auth.email, status.shop) } : {}),
    });
  } catch {
    res.status(503).json({ error: { code: "install_status_unavailable", message: "Could not load this Shopify installation. Try again." } });
  }
}

function tokenFresh(pending: { access_token_expires_at: Date }): boolean {
  return pending.access_token_expires_at.getTime() > Date.now() + REFRESH_EARLY_MS;
}

async function freshPendingInstall(ref: NonNullable<ReturnType<typeof verifyInstallToken>>) {
  const pending = await getPendingShopifyInstall(ref);
  if (!pending) return null;
  if (tokenFresh(pending)) return pending;
  if (pending.refresh_token_expires_at.getTime() <= Date.now()) throw new ShopifyOAuthError("token_rejected");

  if (!(await acquireShopifyRefreshLease(ref))) {
    const again = await getPendingShopifyInstall(ref);
    if (again && tokenFresh(again)) return again;
    throw new Error("shopify_refresh_in_progress");
  }
  try {
    const current = (await getPendingShopifyInstall(ref)) ?? pending;
    if (tokenFresh(current)) return current;
    const grant = await refreshShopifyGrant(current.shop, current.refresh_token);
    const rotated = await persistRotatedShopifyGrant(ref, current.refresh_token, grant);
    if (!rotated) return getPendingShopifyInstall(ref);
    return { ...current, ...grant };
  } finally {
    try { await releaseShopifyRefreshLease(ref); } catch {  }
  }
}

export async function shopifyClaim(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const link = verifyShopifyAppLinkToken((req.body as { token?: unknown } | null)?.token);
  if (link) {
    try {
      const tenantId = await shopifyStaffLinkTenant(link, auth, res);
      if (!tenantId) return;
      if (!(await shopifyAppMemberLinkAvailable({ tenant_id: tenantId, shop: link.shop, shopify_user_id: link.shopify_user_id }))) {
        res.status(409).json({ error: { code: "shopify_identity_linked_elsewhere", message: "This Shopify staff account is linked to another active Zavi workspace for this store." } });
        return;
      }
      res.status(200).json({
        ok: true,
        pending_shopify_confirmation: true,
        redirect_url: shopifyAdminAppConfirmationUrl(link.shop, signShopifyAppLinkConfirmation(link, tenantId, auth.user_id)),
      });
    } catch (e) {
      void logEvent({ level: "error", source: "shopify.connect", code: "shopify_link_prepare_failed", message: (e as Error).message, tenant_id: auth.tenant_id });
      res.status(502).json({ error: { code: "shopify_claim_failed", message: "Could not link this Shopify staff account. Try again." } });
    }
    return;
  }
  const ref = verifyInstallToken((req.body as { token?: unknown } | null)?.token);
  if (!ref) {
    res.status(400).json({ error: { code: "invalid_install", message: "This Shopify installation link is invalid or expired. Open Zavi from Shopify to restart it." } });
    return;
  }
  if (rejectViewerEmailMismatch(ref, auth.email, res)) return;

  if (ref.return_to_app) {
    try {
      const status = await getShopifyInstallStatus(ref);
      if (!status) {
        res.status(410).json({ error: { code: "install_not_found", message: "Open Zavi from Shopify to restart the installation." } });
        return;
      }
      if (status.claimed_tenant_id && status.claimed_tenant_id !== auth.tenant_id) {
        res.status(409).json({ error: { code: "install_already_claimed", message: "This store is already connected to another workspace." } });
        return;
      }
      const confirmation = signShopifyAppHomeConfirmation(ref, auth.tenant_id, auth.user_id);
      res.status(200).json({
        ok: true,
        pending_shopify_confirmation: true,
        redirect_url: shopifyAdminAppConfirmationUrl(status.shop, confirmation),
      });
    } catch (e) {
      void logEvent({ level: "error", source: "shopify.connect", code: "shopify_confirmation_prepare_failed", message: (e as Error).message, tenant_id: auth.tenant_id });
      res.status(502).json({ error: { code: "shopify_claim_failed", message: "Could not finish the Shopify connection. Try again." } });
    }
    return;
  }

  await finishShopifyClaim(ref, auth, res);
}

export async function finishShopifyClaim(
  ref: NonNullable<ReturnType<typeof verifyInstallToken>>,
  auth: Pick<AuthedRequest, "tenant_id" | "user_id" | "email">,
  res: Response,
): Promise<void> {

  try {
    const status = await getShopifyInstallStatus(ref);
    if (!status) {
      res.status(410).json({ error: { code: "install_not_found", message: "Open Zavi from Shopify to restart the installation." } });
      return;
    }
    if (ref.shopify_user_id && !(await shopifyAppMemberLinkAvailable({
      tenant_id: auth.tenant_id,
      shop: status.shop,
      shopify_user_id: ref.shopify_user_id,
    }))) {
      res.status(409).json({ error: { code: "shopify_identity_linked_elsewhere", message: "This Shopify staff account is linked to another active Zavi workspace for this store." } });
      return;
    }
    if (status.claimed_at && !status.has_pending_grant) {
      if (status.claimed_tenant_id === auth.tenant_id) {
        if (ref.shopify_user_id && !(await linkShopifyAppMember({
          tenant_id: auth.tenant_id,
          shop: status.shop,
          shopify_user_id: ref.shopify_user_id,
          user_id: auth.user_id,
        }))) throw new Error("shopify_app_member_link_refused");
        res.status(200).json({ ok: true, already_connected: true, redirect_url: installCompletionUrl(ref, auth.email, status.shop) });
      } else {
        res.status(410).json({ error: { code: "install_not_found", message: "Open Zavi from Shopify to restart the installation." } });
      }
      return;
    }
    if (status.claimed_tenant_id && status.claimed_tenant_id !== auth.tenant_id) {
      res.status(409).json({ error: { code: "install_already_claimed", message: "This store is already connected to another workspace." } });
      return;
    }
    if (!(await reservePendingShopifyInstall(ref, auth.tenant_id))) {
      const current = await getShopifyInstallStatus(ref);
      const claimedElsewhere = current?.claimed_tenant_id && current.claimed_tenant_id !== auth.tenant_id;
      res.status(claimedElsewhere ? 409 : 410).json({
        error: {
          code: claimedElsewhere ? "install_already_claimed" : "install_changed",
          message: claimedElsewhere
            ? "This store is already connected to another workspace."
            : "This Shopify installation changed. Open Zavi from Shopify and try again.",
        },
      });
      return;
    }

    let pending = await freshPendingInstall(ref);
    if (!pending) {
      res.status(410).json({ error: { code: "install_not_found", message: "Open Zavi from Shopify to restart the installation." } });
      return;
    }
    if (ref.shopify_user_id && !(await linkShopifyAppMember({
      tenant_id: auth.tenant_id,
      shop: pending.shop,
      shopify_user_id: ref.shopify_user_id,
      user_id: auth.user_id,
    }))) throw new Error("shopify_app_member_link_refused");

    const authConfigId = await lookupAuthConfigId(TOOLKIT);
    if (!authConfigId) {
      res.status(503).json({ error: { code: "shopify_composio_not_configured", message: "Shopify connection setup is incomplete." } });
      return;
    }
    if (!authConfigSupportsBearerImport(await composioGetAuthConfig(authConfigId))) {
      void logEvent({ level: "error", source: "shopify.connect", code: "shopify_auth_config_not_bearer", tenant_id: auth.tenant_id, meta: { auth_config_id: authConfigId } });
      res.status(503).json({ error: { code: "shopify_auth_config_not_bearer", message: "Shopify connection setup is incomplete." } });
      return;
    }

    const previousAccountId = await storedComposioAccount(auth.tenant_id, TOOLKIT);
    let accountId = pending.composio_account_id;
    let accountOwned = false;
    if (accountId) {
      accountOwned = await composioVerifyOwned({ user_id: auth.tenant_id, auth_config_id: authConfigId, connected_account_id: accountId });
      if (!accountOwned) throw new Error("shopify_pending_account_scope_mismatch");
      await composioPatchBearerToken({ connected_account_id: accountId, access_token: pending.access_token });
      accountOwned = await composioVerifyActive({ user_id: auth.tenant_id, auth_config_id: authConfigId, connected_account_id: accountId });
      if (!accountOwned) throw new Error("shopify_bearer_account_inactive");
    }
    if (!accountOwned) {
      const imported = await composioImportBearerToken({
        user_id: auth.tenant_id,
        auth_config_id: authConfigId,
        access_token: pending.access_token,
        connection_data: { subdomain: shopSubdomain(pending.shop) },
      });
      accountId = imported.connected_account_id;
      const importActive = await composioVerifyActive({
        user_id: auth.tenant_id,
        auth_config_id: authConfigId,
        connected_account_id: accountId,
      }).catch(() => false);
      if (!importActive) {
        try { await composioDisconnect(accountId); } catch {  }
        throw new Error("shopify_imported_account_inactive");
      }
      if (!(await setPendingComposioAccount(ref, auth.tenant_id, accountId, previousAccountId))) {
        try { await composioDisconnect(accountId); } catch {  }
        throw new Error("shopify_install_changed");
      }
      pending = { ...pending, composio_account_id: accountId };
    }
    if (!accountId) throw new Error("shopify_composio_account_missing");

    const { toolsNotAdded } = await ensureToolkitOnMcpServer(TOOLKIT, authConfigId);
    if (toolsNotAdded) {
      void logEvent({ level: "warn", source: "shopify.connect", code: "shopify_composio_tools_not_added", message: toolsNotAdded, tenant_id: auth.tenant_id });
    }
    const { error: saveError } = await tenantRpc(asTenantId(auth.tenant_id), "set_composio_app_connection", {
      p_toolkit: TOOLKIT,
      p_connected_account_id: accountId,
      p_url: buildComposioMcpUrl(auth.tenant_id),
      p_auth_config_id: authConfigId,
    });
    if (saveError) throw new Error(`shopify_connection_save_failed:${saveError.message}`);
    if (!(await saveShopDomain(auth.tenant_id, accountId, pending.shop))) throw new Error("shopify_domain_save_failed");
    if (!(await completePendingShopifyInstall(ref, auth.tenant_id, accountId))) throw new Error("shopify_install_changed");

    if (previousAccountId && previousAccountId !== accountId) {
      try { await composioDisconnect(previousAccountId); } catch {  }
    }
    for (const supersededAccountId of pending.superseded_composio_account_ids) {
      if (supersededAccountId === accountId || supersededAccountId === previousAccountId) continue;
      try { await composioDisconnect(supersededAccountId); } catch {  }
    }
    await recordConnectorEvent({ tenant_id: auth.tenant_id, slug: "composio.shopify", action: "connect", actor_user_id: auth.user_id, via: "shopify_app_install" });
    void notifyFounderActivity({ event: "first_connector", tenant_id: auth.tenant_id, user_id: auth.user_id, details: { connector: TOOLKIT } });
    res.status(200).json({ ok: true, shop: pending.shop, redirect_url: installCompletionUrl(ref, auth.email, pending.shop) });
  } catch (e) {
    const reauthorize = e instanceof ShopifyOAuthError && e.code === "token_rejected";
    void logEvent({ level: "error", source: "shopify.connect", code: reauthorize ? "shopify_reauthorization_required" : "shopify_claim_failed", message: (e as Error).message, tenant_id: auth.tenant_id });
    res.status(reauthorize ? 409 : 502).json({
      error: {
        code: reauthorize ? "shopify_reauthorization_required" : "shopify_claim_failed",
        message: reauthorize
          ? "Shopify authorization expired. Open Zavi from Shopify and approve access again."
          : "Could not finish the Shopify connection. Try again.",
      },
    });
  }
}
