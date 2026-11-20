
import { recordConnectorEvent } from "@/services/connectors/core/connector-events";
import type { Request, Response } from "express";
import { serverClientFromBearer } from "@/services/supabase";
import { requireAuth } from "@/services/auth/middleware";
import { oauthCallbackClient } from "@/services/tenant-client";
import { syncActiveTenant } from "@/services/tenants/active-tenant";
import {
  X_ADS_ACCESS_TOKEN_KEY,
  X_ADS_ACCESS_TOKEN_SECRET_KEY,
  X_ADS_SCREEN_NAME_KEY,
  X_ADS_SLUG,
  X_ADS_USER_ID_KEY,
  X_OAUTH_ACCESS_TOKEN_URL,
  X_OAUTH_AUTHORIZE_URL,
  X_OAUTH_REQUEST_TOKEN_URL,
  xAdsConsumer,
  xAdsEnabled,
} from "@/services/connectors/x-ads/constants";
import { accessToken, requestToken } from "@/services/connectors/x-ads/oauth1";
import { listXAdAccountsRaw } from "@/services/connectors/x-ads/client";
import { notifyFounderActivity } from "@/services/tenants/founder-activity-alert";

const OAUTH_DB_REASON =
  "x_ads OAuth 1.0a: mint/consume the request-token row and write the connection — pre-tenant callback, identity recovered from the single-use request token";

function webOrigin(): string {
  return (process.env.WEB_ORIGIN || "http://localhost:3000").split(",")[0].trim();
}

function callbackUrl(): string {
  const base = process.env.BACKEND_PUBLIC_URL;
  if (!base) throw new Error("BACKEND_PUBLIC_URL must be set so X can reach the callback.");
  return `${base.replace(/\/$/, "")}/api/connectors/x_ads/callback`;
}

export async function xAdsStart(req: Request, res: Response): Promise<void> {
  if (!xAdsEnabled()) {
    res.status(503).json({ error: { code: "connector_misconfigured", message: "X Ads is not configured on this deployment." } });
    return;
  }
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    const rt = await requestToken(xAdsConsumer(), X_OAUTH_REQUEST_TOKEN_URL, callbackUrl());
    const { error } = await oauthCallbackClient(OAUTH_DB_REASON).rpc("mint_x_ads_oauth_request", {
      p_tenant_id: auth.tenant_id,
      p_user_id: auth.user_id,
      p_request_token: rt.key,
      p_request_token_secret: rt.secret,
      p_ttl_seconds: 600,
    });
    if (error) {
      res.status(500).json({ error: { code: "state_mint_failed", message: error.message } });
      return;
    }
    const url = `${X_OAUTH_AUTHORIZE_URL}?${new URLSearchParams({ oauth_token: rt.key })}`;
    if (String(req.headers.accept ?? "").includes("application/json")) {
      res.json({ oauth_url: url });
      return;
    }
    res.redirect(302, url);
  } catch (e) {
    res.status(502).json({ error: { code: "x_request_token_failed", message: (e as Error).message } });
  }
}

export async function xAdsCallback(req: Request, res: Response): Promise<void> {
  const oauthToken = String(req.query.oauth_token ?? "");
  const verifier = String(req.query.oauth_verifier ?? "");
  if (!oauthToken || !verifier) {
    res.status(400).json({ error: { code: "missing_params", message: "X did not return oauth_token+oauth_verifier." } });
    return;
  }
  const { data: rows, error: cErr } = await oauthCallbackClient(OAUTH_DB_REASON).rpc("consume_x_ads_oauth_request", {
    p_request_token: oauthToken,
  });
  if (cErr) {
    res.status(500).json({ error: { code: "state_consume_failed", message: cErr.message } });
    return;
  }
  const row = (rows as Array<{ tenant_id: string; user_id: string; request_token_secret: string }> | null)?.[0];
  if (!row) {
    res.status(403).json({ error: { code: "invalid_state", message: "OAuth request invalid, expired, or replayed." } });
    return;
  }
  try {
    const got = await accessToken(xAdsConsumer(), X_OAUTH_ACCESS_TOKEN_URL, { key: oauthToken, secret: row.request_token_secret }, verifier);
    const accounts = await listXAdAccountsRaw(got.token);
    const first = accounts[0];
    const { error: setErr } = await oauthCallbackClient(OAUTH_DB_REASON).rpc("set_connector_connection", {
      p_tenant_id: row.tenant_id,
      p_slug: X_ADS_SLUG,
      p_server_id: X_ADS_SLUG,
      p_secrets: {
        [X_ADS_ACCESS_TOKEN_KEY]: got.token.key,
        [X_ADS_ACCESS_TOKEN_SECRET_KEY]: got.token.secret,
        [X_ADS_USER_ID_KEY]: got.userId,
        [X_ADS_SCREEN_NAME_KEY]: got.screenName,
      },
      p_expires_at: null,
      p_team_id: first?.id ?? "no_ad_account",
      p_team_name: first
        ? `${first.name}${accounts.length > 1 ? ` (+${accounts.length - 1})` : ""}`
        : `X Ads (@${got.screenName || "connected"}, no ad account)`,
      p_scopes: ["ads_read"],
    });
    if (setErr) {
      res.status(500).json({ error: { code: "set_connector_connection_failed", message: setErr.message } });
      return;
    }
    await recordConnectorEvent({ tenant_id: row.tenant_id, slug: X_ADS_SLUG, action: "connect", actor_user_id: row.user_id, via: "x_ads_callback" });
    void notifyFounderActivity({ event: "first_connector", tenant_id: row.tenant_id, user_id: row.user_id, details: { connector: "x_ads" } });
    await syncActiveTenant(row.user_id, row.tenant_id);
    res.redirect(302, `${webOrigin()}/workspace?tab=settings&${X_ADS_SLUG}=connected`);
  } catch (e) {
    res.status(502).json({ error: { code: "connector_exchange_failed", message: (e as Error).message } });
  }
}

export async function xAdsDisconnect(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const { error } = await serverClientFromBearer(auth.access_token).rpc("disconnect_connector", {
    p_tenant_id: auth.tenant_id,
    p_slug: X_ADS_SLUG,
    p_server_id: X_ADS_SLUG,
  });
  if (error) {
    if (error.code === "42501") {
      res.status(403).json({ error: { code: "not_admin", message: error.message } });
      return;
    }
    if (error.code === "PGRST202" || error.code === "42883") {
      res.status(500).json({
        error: {
          code: "rpc_missing",
          message: "Disconnect is temporarily unavailable: a pending database migration has not been applied.",
        },
      });
      return;
    }
    res.status(500).json({ error: { code: "rpc_failed", message: error.message } });
    return;
  }
  res.json({ ok: true });
}
