import crypto from "node:crypto";
import { oauthCallbackClient } from "@/services/tenant-client";
import { higgsfieldAuthorizeUrl, exchangeHiggsfieldCode } from "@/services/connectors/higgsfield/oauth";

import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { serviceClient } from "@/services/supabase";
import { serverClientFromBearer } from "@/services/supabase";
import { probeHiggsfield } from "@/services/connectors/higgsfield/connect";
import { notifyFounderActivity } from "@/services/tenants/founder-activity-alert";

const bodySchema = z.object({
  access_token: z.string().min(8),
  workspace_id: z.string().min(1).max(200).optional(),
  workspace_name: z.string().min(1).max(200).optional(),
});

export async function higgsfieldConnect(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: "invalid_body",
        message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      },
    });
    return;
  }
  const { access_token, workspace_id, workspace_name } = parsed.data;

  const probe = await probeHiggsfield(access_token);
  if (!probe.ok) {
    res.status(400).json({
      error: {
        code: "higgsfield_token_invalid",
        message: `Higgsfield rejected the token (probe failed): ${probe.error}`,
      },
    });
    return;
  }

  const { error } = await serviceClient().rpc("set_higgsfield_connection", {
    p_tenant_id: auth.tenant_id,
    p_access_token: access_token,
    p_workspace_id: workspace_id ?? "",
    p_workspace_name: workspace_name ?? null,
  });
  if (error) {
    console.error("higgsfield_connect_failed", { tenant_id: auth.tenant_id, error_code: error.code });
    res.status(500).json({
      error: {
        code: "higgsfield_connect_failed",
        message: "Failed to save Higgsfield connection. Check server logs.",
      },
    });
    return;
  }

  void notifyFounderActivity({ event: "first_connector", tenant_id: auth.tenant_id, user_id: auth.user_id, details: { connector: "higgsfield" } });
  res.json({ ok: true, balance: probe.balance });
}

const HF_OAUTH_DB_REASON =
  "higgsfield OAuth: pre-tenant state-nonce mint/consume + connection persist";

const hfHash = (v: string) => crypto.createHash("sha256").update(v).digest("hex");
const hfWebOrigin = () => (process.env.WEB_ORIGIN || "http://localhost:3000").split(",")[0].trim();
const hfWantsJson = (req: Request) => String(req.headers.accept ?? "").includes("application/json");

export async function higgsfieldStart(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const state = crypto.randomBytes(32).toString("base64url");
  const { error } = await oauthCallbackClient(HF_OAUTH_DB_REASON).rpc("mint_oauth_state", {
    p_provider: "higgsfield",
    p_tenant_id: auth.tenant_id,
    p_user_id: auth.user_id,
    p_state_hash: hfHash(state),
    p_ttl_seconds: 600,
  });
  if (error) {
    res.status(500).json({ error: { code: "state_mint_failed" } });
    return;
  }
  try {
    const oauth_url = await higgsfieldAuthorizeUrl(state);
    if (hfWantsJson(req)) {
      res.json({ oauth_url });
      return;
    }
    res.redirect(302, oauth_url);
  } catch (e) {
    res
      .status(500)
      .json({ error: { code: "higgsfield_misconfigured", message: (e as Error).message } });
  }
}

export async function higgsfieldCallback(req: Request, res: Response): Promise<void> {
  const code = String(req.query.code || "");
  const state = String(req.query.state || "");
  if (!code || !state) {
    res.status(400).send("Higgsfield did not return code and state.");
    return;
  }
  const { data, error } = await oauthCallbackClient(HF_OAUTH_DB_REASON).rpc("consume_oauth_state", {
    p_provider: "higgsfield",
    p_state_hash: hfHash(state),
  });
  const owner = (data as Array<{ tenant_id: string; user_id: string }> | null)?.[0];
  if (error || !owner) {
    res.status(403).send("Higgsfield authorization state is invalid, expired, or already used.");
    return;
  }

  let stage = "exchange";
  try {
    const tok = await exchangeHiggsfieldCode(code, state);

    stage = "probe";
    const probe = await probeHiggsfield(tok.access_token);
    if (!probe.ok) throw new Error(`token rejected by Higgsfield: ${probe.error}`);

    stage = "persist";
    const { error: setError } = await oauthCallbackClient(HF_OAUTH_DB_REASON).rpc(
      "set_higgsfield_connection",
      {
        p_tenant_id: owner.tenant_id,
        p_access_token: tok.access_token,
        p_workspace_id: "",
        p_workspace_name: null,
      },
    );
    if (setError) throw new Error(setError.message);

    if (tok.refresh_token) {
      const ttlSec = typeof tok.expires_in === "number" && tok.expires_in > 0 ? tok.expires_in : 86_400;
      const { error: refErr } = await oauthCallbackClient(HF_OAUTH_DB_REASON).rpc(
        "refresh_connector_secrets",
        {
          p_tenant_id: owner.tenant_id,
          p_slug: "higgsfield",
          p_secrets: {
            "higgsfield.access_token": tok.access_token,
            "higgsfield.refresh_token": tok.refresh_token,
          },
          p_expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
        },
      );
      if (refErr) throw new Error(refErr.message);
    }

    void notifyFounderActivity({ event: "first_connector", tenant_id: owner.tenant_id, user_id: owner.user_id, details: { connector: "higgsfield" } });
    const target = `${hfWebOrigin()}/workspace?tab=settings&higgsfield=connected`;
    res
      .status(200)
      .type("html")
      .send(
        `<!doctype html><meta charset="utf-8"><title>Connected</title>` +
          `<body style="font:16px system-ui;padding:3rem">` +
          `<h1>Connected to Higgsfield ✓</h1>` +
          `<p>Your agents can now generate images and video on this account.</p>` +
          `<p style="color:#666">This tab will close automatically.</p>` +
          `<script>(function(){var t=${JSON.stringify(target)};` +
          `try{if(window.opener&&!window.opener.closed){window.opener.location.href=t;window.close();return;}}catch(e){}` +
          `window.location.href=t;})();</script></body>`,
      );
  } catch (e) {
    console.error("higgsfield_oauth_callback_failed", { stage, message: (e as Error).message });
    res.status(502).send("Higgsfield connection failed. Close this tab and try again from Settings.");
  }
}

export async function higgsfieldDisconnect(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const authHeader = String(req.headers.authorization ?? "");
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : authHeader;
  const { error } = await serverClientFromBearer(bearer).rpc("disconnect_higgsfield", {
    p_tenant_id: auth.tenant_id,
  });
  if (error) {
    res.status(500).json({ error: { code: "higgsfield_disconnect_failed" } });
    return;
  }
  res.json({ ok: true });
}
