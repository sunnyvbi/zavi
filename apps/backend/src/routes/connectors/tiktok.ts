import crypto from "node:crypto";
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";
import { getSecret } from "@/services/secrets/vault";
import { oauthCallbackClient } from "@/services/tenant-client";
import { exchangeTikTokCode, revokeTikTokToken, tiktokAuthorizeUrl } from "@/services/connectors/tiktok/api";
import { handleConnectorAccountSwap, priorConnectorTeamId } from "@/services/connectors/core/token";
import { notifyFounderActivity } from "@/services/tenants/founder-activity-alert";

const OAUTH_DB_REASON = "tiktok OAuth: pre-tenant state-nonce mint/consume + connection persist";

const hash = (v: string) => crypto.createHash("sha256").update(v).digest("hex");
const webOrigin = () => (process.env.WEB_ORIGIN || "http://localhost:3000").split(",")[0].trim();
const wantsJson = (req: Request) => String(req.headers.accept ?? "").includes("application/json");

export async function tiktokStart(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const state = crypto.randomBytes(32).toString("base64url");
  const { error } = await oauthCallbackClient(OAUTH_DB_REASON).rpc("mint_oauth_state", {
    p_provider: "tiktok", p_tenant_id: auth.tenant_id, p_user_id: auth.user_id,
    p_state_hash: hash(state), p_ttl_seconds: 600,
  });
  if (error) { res.status(500).json({ error: { code: "state_mint_failed" } }); return; }
  try {
    const oauth_url = tiktokAuthorizeUrl(state);
    if (wantsJson(req)) { res.json({ oauth_url }); return; }
    res.redirect(302, oauth_url);
  }
  catch (e) { res.status(500).json({ error: { code: "tiktok_misconfigured", message: (e as Error).message } }); }
}

export async function tiktokCallback(req: Request, res: Response): Promise<void> {
  const code = String(req.query.code || "");
  const state = String(req.query.state || "");
  if (!code || !state) { res.status(400).send("TikTok did not return code and state."); return; }
  const { data, error } = await oauthCallbackClient(OAUTH_DB_REASON).rpc("consume_oauth_state", {
    p_provider: "tiktok", p_state_hash: hash(state),
  });
  const owner = (data as Array<{ tenant_id: string; user_id: string }> | null)?.[0];
  if (error || !owner) { res.status(403).send("TikTok authorization state is invalid, expired, or already used."); return; }
  let stage = "exchange";
  try {
    const token = await exchangeTikTokCode(code);
    stage = "persist";
    const priorOpenId = await priorConnectorTeamId(owner.tenant_id, "tiktok");
    const { error: setError } = await oauthCallbackClient(OAUTH_DB_REASON).rpc("set_tiktok_connection", {
      p_tenant_id: owner.tenant_id,
      p_access_token: token.access_token,
      p_refresh_token: token.refresh_token,
      p_open_id: token.open_id,
      p_scopes: token.scope.split(",").map((s) => s.trim()).filter(Boolean),
      p_expires_at: new Date(Date.now() + token.expires_in * 1000).toISOString(),
    });
    if (setError) throw new Error(setError.message);
    if (priorOpenId && priorOpenId !== token.open_id) {
      await handleConnectorAccountSwap(owner.tenant_id, "tiktok");
    }
    void notifyFounderActivity({ event: "first_connector", tenant_id: owner.tenant_id, user_id: owner.user_id, details: { connector: "tiktok" } });
    res.redirect(302, `${webOrigin()}/workspace?tab=settings&tiktok=connected`);
  } catch (e) {
    console.error("tiktok_oauth_callback_failed", { stage, message: (e as Error).message });
    res.status(502).send("TikTok connection failed. Close this tab and try again from Settings.");
  }
}

export async function tiktokDisconnect(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const authHeader = String(req.headers.authorization ?? "");
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : authHeader;

  const accessToken = await getSecret(auth.tenant_id, "tiktok.access_token").catch(() => null);

  const { error } = await serverClientFromBearer(bearer).rpc("disconnect_tiktok", { p_tenant_id: auth.tenant_id });
  if (error) {
    const code = (error as { code?: string }).code;
    if (code === "42501") { res.status(403).json({ error: { code: "not_admin", message: error.message } }); return; }
    if (code === "PGRST202" || code === "42883") {
      res.status(500).json({ error: { code: "rpc_missing", message: "TikTok disconnect is temporarily unavailable: a pending database migration has not been applied." } });
      return;
    }
    res.status(500).json({ error: { code: "rpc_failed", message: error.message } });
    return;
  }
  if (accessToken) {
    void revokeTikTokToken(accessToken).catch((e) =>
      console.warn("tiktok_revoke_failed", { message: (e as Error).message }));
  }
  res.status(200).json({ ok: true });
}
