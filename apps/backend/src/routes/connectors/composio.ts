
import { recordConnectorEvent } from "@/services/connectors/core/connector-events";
import type { Request, Response } from "express";
import crypto from "node:crypto";
import { requireAuth } from "@/services/auth/middleware";
import { serviceClient } from "@/services/supabase";
import { syncActiveTenant } from "@/services/tenants/active-tenant";
import { connectedLanding, safeReturnPath, stateWithReturn } from "./connector";
import { railFor } from "@zavi/shared";
import { buildComposioMcpUrl } from "@/services/connectors/composio/api-key";
import {
  listComposioCatalog,
  isConnectable,
  lookupAuthConfigId,
  ensureAuthConfigForConnect,
  ensureToolkitOnMcpServer,
} from "@/services/connectors/composio/catalog";
import { NATIVE_ONLY_TOOLKITS, TILE_TOOLKITS, NATIVELY_SERVED_TOOLKITS } from "@/services/connectors/composio/native-map";
import { completeGoogleAnalyticsComposioConnect } from "./google-analytics";
import { completeGoogleSearchConsoleComposioConnect } from "./google-search-console";
import { renderGoogleConnectFailHtml } from "@/services/connectors/google-connect-fail";
import { logEvent } from "@/services/logging/logEvent";
import { recordAppRequest, defaultAppRequestDeps } from "@/services/connectors/app-request-alert";
import {
  composioLink,
  composioVerifyActive,
  composioDisconnect,
} from "@/services/connectors/composio/api";
import { notifyFounderActivity } from "@/services/tenants/founder-activity-alert";
import { syncAdAccounts } from "@/services/connectors/tiktok-ads/ad-accounts";
import { autoSetCompanyCountryInBackground } from "@/services/company/country-inference";
import { resolveOwnedComposioAccount } from "@/services/connectors/composio/account";
import { connectionDataFor } from "@/services/connectors/composio/connection-data";
import { deleteComposioRow, storedComposioAccount } from "@/services/connectors/composio/connection-row";
import { disconnectTenantShop, rememberShopDomain, storedShop } from "@/services/connectors/shopify/store";

const AD_ACCOUNT_SYNC_MS = 15_000;

async function saveTiktokAdAccountsAtConnect(tenant_id: string): Promise<void> {
  const work = (async () => {
    const account = await resolveOwnedComposioAccount(tenant_id, "tiktok_ads");
    if (account) await syncAdAccounts(account);
    if (account) autoSetCompanyCountryInBackground(tenant_id);
  })();
  try {
    await Promise.race([work, new Promise((resolve) => setTimeout(resolve, AD_ACCOUNT_SYNC_MS))]);
  } catch {
    void logEvent({ level: "warn", source: "composio.connect", code: "tiktok_ads_account_sync_failed", tenant_id });
  }
  work.catch(() => {});
}

export { TOOLKIT_NAME_OVERRIDES, toolkitDisplayName } from "@/services/connectors/composio/display-name";

export { NATIVE_ONLY_TOOLKITS, TILE_TOOLKITS };

const SLUG_RE = /^[a-z0-9_-]{1,64}$/;

export async function composioToolkits(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    const [catalog, reqRows] = await Promise.all([
      listComposioCatalog(),
      serviceClient().from("connector_app_requests").select("app_slug").eq("tenant_id", auth.tenant_id),
    ]);
    const toolkits = catalog
      .filter((t) => !NATIVE_ONLY_TOOLKITS.has(t.slug) && !TILE_TOOLKITS.has(t.slug))
      .map((t) => ({ slug: t.slug, name: t.name, logo: t.logo, category: t.category, connectable: isConnectable(t) }));
    const requested = ((reqRows.data ?? []) as { app_slug: string }[]).map((r) => r.app_slug);
    res.status(200).json({ toolkits, requested });
  } catch (e) {
    res.status(502).json({ error: { code: "composio_catalog_failed", message: (e as Error).message } });
  }
}

function backendPublicUrl(): string {
  const base = process.env.BACKEND_PUBLIC_URL?.trim();
  if (!base) {
    throw new Error("BACKEND_PUBLIC_URL must be set so Composio can reach the /return callback.");
  }
  return base.replace(/\/$/, "");
}

function webOrigin(): string {
  return (process.env.WEB_ORIGIN || "http://localhost:3000").split(",")[0].trim();
}

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

async function resolveToolkit(toolkit: string, mode: "connect" | "return"): Promise<string | null> {
  const safe = toolkit.trim().toLowerCase();
  if (!SLUG_RE.test(safe)) return null;
  if (railFor(safe) !== "composio") return null;
  const t = (await listComposioCatalog()).find((x) => x.slug === safe);
  if (!t || !isConnectable(t)) return null;
  if (mode === "return") return lookupAuthConfigId(safe);
  return ensureAuthConfigForConnect(t);
}

const CONNECT_FAILED_MESSAGE = "Couldn't start the connection. Try again in a minute.";

export async function composioConnectStart(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const toolkit = String(req.params.toolkit ?? "").trim().toLowerCase();
  const popup = (req.body as { popup?: unknown } | undefined)?.popup === true;
  if (toolkit === "shopify") {
    res.status(409).json({
      error: { code: "shopify_use_app_install", message: "Zavi's Shopify app is in App Store review. You can connect Shopify here once it is live." },
    });
    return;
  }
  let authConfigId: string | null;
  try {
    authConfigId = await resolveToolkit(toolkit, "connect");
  } catch (e) {
    console.warn(`[composio/connect] ${toolkit}: resolve toolkit failed (${(e as Error).message}).`);
    res.status(502).json({ error: { code: "composio_link_failed", message: CONNECT_FAILED_MESSAGE } });
    return;
  }
  if (!authConfigId) {
    res
      .status(404)
      .json({ error: { code: "unknown_toolkit", message: `No composio toolkit "${toolkit}".` } });
    return;
  }

  const connection = connectionDataFor(toolkit, req.body);
  if (!connection.ok) {
    res.status(400).json({
      error: { code: "connection_data_required", message: `Enter your ${connection.field.label.toLowerCase()} to connect.`, field: connection.field },
    });
    return;
  }
  const rawState = stateWithReturn(
    crypto.randomBytes(32).toString("base64url"),
    safeReturnPath((req.body as { return_to?: unknown } | undefined)?.return_to),
  );
  const stateHash = sha256Hex(rawState);
  const { error: stateErr } = await serviceClient().rpc("mint_oauth_state", {
    p_provider: "composio",
    p_tenant_id: auth.tenant_id,
    p_user_id: auth.user_id,
    p_state_hash: stateHash,
    p_ttl_seconds: 600,
  });
  if (stateErr) {
    res
      .status(500)
      .json({ error: { code: "state_mint_failed", message: stateErr.message } });
    return;
  }

  try {
    const callback = `${backendPublicUrl()}/api/connectors/composio/${encodeURIComponent(
      toolkit,
    )}/return?state=${encodeURIComponent(rawState)}${popup ? "&popup=1" : ""}`;
    const link = await composioLink({
      user_id: auth.tenant_id,
      auth_config_id: authConfigId,
      callback_url: callback,
      ...(connection.data ? { connection_data: connection.data } : {}),
    });
    const { data: bound, error: bindErr } = await serviceClient().rpc("bind_oauth_state_account", {
      p_provider: "composio",
      p_state_hash: stateHash,
      p_connected_account_id: link.connected_account_id,
    });
    if (bindErr || bound !== true) {
      try { await composioDisconnect(link.connected_account_id); } catch {  }
      throw new Error(`bind_oauth_state_account: ${bindErr?.message ?? "state not bound"}`);
    }
    res.status(200).json({
      oauth_url: link.redirect_url,
      connected_account_id: link.connected_account_id,
    });
  } catch (e) {
    console.warn(`[composio/connect] ${toolkit}: link failed (${(e as Error).message}).`);
    res.status(502).json({ error: { code: "composio_link_failed", message: CONNECT_FAILED_MESSAGE } });
  }
}

type ReturnFailure =
  | "unknown_toolkit"
  | "missing_state"
  | "missing_params"
  | "state_consume_failed"
  | "invalid_state"
  | "composio_verify_failed"
  | "connection_not_owned"
  | "shopify_store_unknown"
  | "mcp_sync_failed"
  | "set_composio_app_connection_failed";

function returnFail(res: Response, toolkit: string, code: ReturnFailure, popup = false): void {
  if (popup) return popupDone(res, toolkit, "error", code);
  const qs = new URLSearchParams({ composio_error: SLUG_RE.test(toolkit) ? toolkit : "unknown", code });
  res.redirect(302, `${webOrigin()}/workspace?tab=settings&${qs.toString()}`);
}

function popupDone(res: Response, toolkit: string, status: "connected" | "error", reason?: ReturnFailure): void {
  const qs = new URLSearchParams({ toolkit: SLUG_RE.test(toolkit) ? toolkit : "unknown", status });
  if (reason) qs.set("reason", reason);
  res.redirect(302, `${webOrigin()}/connectors/composio/done?${qs.toString()}`);
}

async function undoComposioConnect(tenant_id: string, toolkit: string, connectedAccountId: string): Promise<void> {
  try {
    await composioDisconnect(connectedAccountId);
  } catch (e) {
    void logEvent({
      level: "warn",
      source: "composio.connect",
      code: "composio_undo_revoke_failed",
      message: (e as Error).message,
      tenant_id,
      meta: { connector_slug: `composio.${toolkit}` },
    });
    return;
  }
  const delErr = await deleteComposioRow(tenant_id, `composio.${toolkit}`, connectedAccountId);
  if (delErr) {
    void logEvent({
      level: "warn",
      source: "composio.connect",
      code: "composio_undo_row_delete_failed",
      message: delErr.message,
      tenant_id,
      meta: { connector_slug: `composio.${toolkit}` },
    });
  }
}

export async function composioReturn(req: Request, res: Response): Promise<void> {
  const toolkit = String(req.params.toolkit ?? "").trim().toLowerCase();
  const popup = req.query.popup === "1";
  let authConfigId: string | null;
  try {
    authConfigId = await resolveToolkit(toolkit, "return");
  } catch {
    return returnFail(res, toolkit, "composio_verify_failed", popup);
  }
  if (!authConfigId) return returnFail(res, toolkit, "unknown_toolkit", popup);

  const rawState = String(req.query.state ?? "").trim();
  if (!rawState) return returnFail(res, toolkit, "missing_state", popup);

  let connectedAccountId = String(req.query.connected_account_id ?? req.query.connectedAccountId ?? "").trim();

  const stateHash = sha256Hex(rawState);
  const { data: rows, error: cErr } = await serviceClient().rpc("consume_oauth_state_bound", {
    p_provider: "composio",
    p_state_hash: stateHash,
  });
  if (cErr) return returnFail(res, toolkit, "state_consume_failed", popup);
  const tenantUser = (rows as Array<{ tenant_id: string; user_id: string; connected_account_id?: string | null }> | null)?.[0];
  if (!tenantUser) return returnFail(res, toolkit, "invalid_state", popup);

  const boundAccountId = typeof tenantUser.connected_account_id === "string" ? tenantUser.connected_account_id.trim() : "";
  if (connectedAccountId && boundAccountId && connectedAccountId !== boundAccountId) {
    return returnFail(res, toolkit, "connection_not_owned", popup);
  }
  if (!connectedAccountId) connectedAccountId = boundAccountId;
  if (!connectedAccountId) return returnFail(res, toolkit, "missing_params", popup);

  let active = false;
  try {
    active = await composioVerifyActive({
      user_id: tenantUser.tenant_id,
      auth_config_id: authConfigId,
      connected_account_id: connectedAccountId,
    });
  } catch {
    return returnFail(res, toolkit, "composio_verify_failed", popup);
  }
  if (!active) return returnFail(res, toolkit, "connection_not_owned", popup);

  const previousAccountId = await storedComposioAccount(tenantUser.tenant_id, toolkit);

  try {
    if (!NATIVELY_SERVED_TOOLKITS.has(toolkit)) {
      const { toolsNotAdded } = await ensureToolkitOnMcpServer(toolkit, authConfigId);
      if (toolsNotAdded) {
        void logEvent({
          level: "warn",
          source: "composio.connect",
          code: "composio_mcp_tools_not_added",
          message: toolsNotAdded,
          tenant_id: tenantUser.tenant_id,
          meta: { connector_slug: `composio.${toolkit}` },
        });
      }
    }
  } catch (e) {
    void logEvent({
      level: "warn",
      source: "composio.connect",
      code: "composio_mcp_sync_failed",
      message: (e as Error).message,
      tenant_id: tenantUser.tenant_id,
      meta: { connector_slug: `composio.${toolkit}` },
    });
    if (previousAccountId !== null && connectedAccountId !== previousAccountId) {
      try { await composioDisconnect(connectedAccountId); } catch {  }
    }
    return returnFail(res, toolkit, "mcp_sync_failed", popup);
  }

  const url = buildComposioMcpUrl(tenantUser.tenant_id);
  const { error } = await serviceClient().rpc("set_composio_app_connection", {
    p_tenant_id: tenantUser.tenant_id,
    p_toolkit: toolkit,
    p_connected_account_id: connectedAccountId,
    p_url: url,
    p_auth_config_id: authConfigId,
  });
  if (error) {
    if (previousAccountId !== null && connectedAccountId !== previousAccountId) {
      try { await composioDisconnect(connectedAccountId); } catch {  }
    }
    return returnFail(res, toolkit, "set_composio_app_connection_failed", popup);
  }

  if (previousAccountId && previousAccountId !== connectedAccountId) {
    const nowStored = await storedComposioAccount(tenantUser.tenant_id, toolkit);
    if (nowStored && nowStored !== previousAccountId) {
      try { await composioDisconnect(previousAccountId); } catch {  }
    }
  }

  const recordConnect = async (): Promise<void> => {
    await recordConnectorEvent({ tenant_id: tenantUser.tenant_id, slug: `composio.${toolkit}`, action: "connect", actor_user_id: tenantUser.user_id, via: "composio_return" });
    void notifyFounderActivity({ event: "first_connector", tenant_id: tenantUser.tenant_id, user_id: tenantUser.user_id, details: { connector: toolkit } });
  };

  await syncActiveTenant(tenantUser.user_id, tenantUser.tenant_id);

  if (toolkit === "google_analytics" || toolkit === "google_search_console") {
    const outcome = toolkit === "google_analytics"
      ? await completeGoogleAnalyticsComposioConnect(tenantUser, connectedAccountId, res)
      : await completeGoogleSearchConsoleComposioConnect(tenantUser, connectedAccountId, res);
    if (outcome === "scope_missing") {
      await undoComposioConnect(tenantUser.tenant_id, toolkit, connectedAccountId);
      res.status(400).send(renderGoogleConnectFailHtml(toolkit, "google_scope_missing"));
      return;
    }
    return recordConnect();
  }
  if (toolkit === "shopify" && !(await rememberShopDomain(tenantUser.tenant_id, connectedAccountId))) {
    await undoComposioConnect(tenantUser.tenant_id, toolkit, connectedAccountId);
    return returnFail(res, toolkit, "shopify_store_unknown", popup);
  }
  await recordConnect();
  if (toolkit === "tiktok_ads") await saveTiktokAdAccountsAtConnect(tenantUser.tenant_id);
  if (toolkit === "mailchimp" || toolkit === "klaviyo") {
    void import("@/services/email-learnings/seed").then((m) => m.requestSeed(tenantUser.tenant_id)).catch(() => undefined);
  }

  if (popup) return popupDone(res, toolkit, "connected");
  res.redirect(302, connectedLanding(`composio_${encodeURIComponent(toolkit)}`, rawState));
}

export async function composioDisconnectRoute(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const toolkit = String(req.params.toolkit ?? "").trim().toLowerCase();
  if (!SLUG_RE.test(toolkit)) {
    res
      .status(404)
      .json({ error: { code: "unknown_toolkit", message: "No composio toolkit with that name." } });
    return;
  }
  const slug = `composio.${toolkit}`;

  const { data: row } = await serviceClient()
    .from("connector_metadata")
    .select("team_id")
    .eq("tenant_id", auth.tenant_id)
    .eq("slug", slug)
    .maybeSingle();
  if (!row) {
    res
      .status(404)
      .json({ error: { code: "unknown_toolkit", message: `No composio toolkit "${toolkit}".` } });
    return;
  }
  const accountId = (row as { team_id?: string } | null)?.team_id ?? "";

  if (toolkit === "shopify") {
    const shop = await storedShop(auth.tenant_id);
    if (!shop) {
      res.status(502).json({
        error: { code: "shopify_store_unknown", message: "We could not disconnect this store right now. Try again." },
      });
      return;
    }
    try {
      await disconnectTenantShop(auth.tenant_id, shop, accountId, "composio_disconnect");
    } catch (e) {
      console.warn(`[composio/disconnect] Shopify cleanup failed (${(e as Error).message}); keeping retry visible.`);
      res.status(502).json({
        error: { code: "upstream_disconnect_failed", message: "We could not disconnect this app right now. Try again." },
      });
      return;
    }
    await recordConnectorEvent({ tenant_id: auth.tenant_id, slug, action: "disconnect", actor_user_id: auth.user_id, via: "composio_disconnect" });
    res.status(200).json({ ok: true });
    return;
  }

  if (accountId) {
    try {
      await composioDisconnect(accountId);
    } catch (e) {
      console.warn(`[composio/disconnect] upstream delete failed (${(e as Error).message}); keeping local row.`);
      res.status(502).json({
        error: { code: "upstream_disconnect_failed", message: "We could not disconnect this app right now. Try again." },
      });
      return;
    }
  }

  const delErr = await deleteComposioRow(auth.tenant_id, slug);
  if (delErr) {
    res.status(500).json({ error: { code: "row_delete_failed", message: delErr.message } });
    return;
  }
  await recordConnectorEvent({ tenant_id: auth.tenant_id, slug, action: "disconnect", actor_user_id: auth.user_id, via: "composio_disconnect" });

  res.status(200).json({ ok: true });
}

export async function composioRequestApp(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const slug = String(req.params.toolkit ?? "").trim().toLowerCase();
  try {
    const t = SLUG_RE.test(slug) && railFor(slug) === "composio"
      ? (await listComposioCatalog()).find((x) => x.slug === slug)
      : undefined;
    if (!t || isConnectable(t)) {
      res.status(404).json({ error: { code: "unknown_toolkit", message: "No requestable app with that name." } });
      return;
    }
    const out = await recordAppRequest(
      { tenant_id: auth.tenant_id, user_id: auth.user_id, app_slug: slug, app_name: t.name },
      await defaultAppRequestDeps(),
    );
    res.status(200).json({ requested: out.requested });
  } catch (e) {
    res.status(502).json({ error: { code: "app_request_failed", message: (e as Error).message } });
  }
}
