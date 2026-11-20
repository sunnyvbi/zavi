
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { serviceClient } from "@/services/supabase";
import { verifyConsentState } from "@/services/auth/oauth/state";
import { generateToken, CODE_PREFIX, CODE_TTL_SECONDS } from "@/services/auth/oauth/tokens";

function noStore(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
}

function badReq(res: Response, message: string): void {
  res.status(400).json({ error: { code: "invalid_request", message } });
}

export async function oauthConsentInfo(req: Request, res: Response): Promise<void> {
  noStore(res);
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const state = verifyConsentState(String(req.body?.req ?? ""));
  if (!state) return badReq(res, "invalid or expired consent request");

  const sb = serviceClient();
  const [{ data: client }, { data: tenant }] = await Promise.all([
    sb.from("oauth_clients").select("client_name").eq("client_id", state.client_id).maybeSingle(),
    sb.from("tenants").select("display_name").eq("id", auth.tenant_id).maybeSingle(),
  ]);
  res.json({
    client_name: client?.client_name ?? "An application",
    scopes: state.scopes,
    tenant_name: tenant?.display_name ?? "your workspace",
  });
}

export async function oauthConsentApprove(req: Request, res: Response): Promise<void> {
  noStore(res);
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const state = verifyConsentState(String(req.body?.req ?? ""));
  if (!state) return badReq(res, "invalid or expired consent request");

  const sb = serviceClient();
  const { data: fresh, error: jErr } = await sb.rpc("consume_consent_jti", {
    p_jti: state.jti,
    p_expires_at: new Date((state.iat + 300) * 1000).toISOString(),
  });
  if (jErr) return badReq(res, "consent verification failed");
  if (fresh !== true) {
    res.status(409).json({
      error: { code: "consent_replayed", message: "This consent request was already used." },
    });
    return;
  }

  const code = generateToken(CODE_PREFIX);
  const { error: mErr } = await sb.rpc("mint_oauth_code", {
    p_code_hash: code.hash,
    p_code_salt: code.salt,
    p_code_prefix: code.prefix,
    p_client_id: state.client_id,
    p_user_id: auth.user_id,
    p_tenant_id: auth.tenant_id,
    p_redirect_uri: state.redirect_uri,
    p_code_challenge: state.code_challenge,
    p_scopes: state.scopes,
    p_resource: state.resource,
    p_ttl_seconds: CODE_TTL_SECONDS,
  });
  if (mErr) {
    res.status(500).json({ error: { code: "internal", message: mErr.message } });
    return;
  }

  const url = new URL(state.redirect_uri);
  url.searchParams.set("code", code.raw);
  if (state.state) url.searchParams.set("state", state.state);
  res.json({ redirect: url.toString() });
}

export async function oauthConsentDeny(req: Request, res: Response): Promise<void> {
  noStore(res);
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const state = verifyConsentState(String(req.body?.req ?? ""));
  if (!state) return badReq(res, "invalid or expired consent request");
  const url = new URL(state.redirect_uri);
  url.searchParams.set("error", "access_denied");
  if (state.state) url.searchParams.set("state", state.state);
  res.json({ redirect: url.toString() });
}
