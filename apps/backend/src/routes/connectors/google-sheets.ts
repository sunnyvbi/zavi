
import type { Request, Response } from "express";
import crypto from "node:crypto";
import { requireAuth } from "@/services/auth/middleware";
import { oauthCallbackClient } from "@/services/tenant-client";
import { syncActiveTenant } from "@/services/tenants/active-tenant";
import { googleSheetsOAuthStartUrl, exchangeCode } from "@/services/connectors/google-sheets/oauth";
import { notifyFounderActivity } from "@/services/tenants/founder-activity-alert";

const OAUTH_DB_REASON = "google-sheets OAuth: pre-tenant state-nonce recovery + connection persist";

function webOrigin(): string {
  return (process.env.WEB_ORIGIN || "http://localhost:3000").split(",")[0].trim();
}
function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}
function wantsJson(req: Request): boolean {
  return String(req.headers["accept"] ?? "").includes("application/json");
}
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export async function googleSheetsStart(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const rawState = crypto.randomBytes(32).toString("base64url");
  const { error } = await oauthCallbackClient(OAUTH_DB_REASON).rpc("mint_oauth_state", {
    p_provider: "google_sheets",
    p_tenant_id: auth.tenant_id,
    p_user_id: auth.user_id,
    p_state_hash: sha256Hex(rawState),
    p_ttl_seconds: 600,
  });
  if (error) {
    res.status(500).json({ error: { code: "state_mint_failed", message: error.message } });
    return;
  }
  try {
    const url = googleSheetsOAuthStartUrl(rawState);
    if (wantsJson(req)) {
      res.json({ oauth_url: url });
      return;
    }
    res.redirect(302, url);
  } catch (e) {
      console.error("google_sheets_misconfigured", (e as Error).message);
    res.status(500).json({ error: { code: "google_sheets_misconfigured", message: "This integration is not configured yet. Zavi has been notified." } });
  }
}

export async function googleSheetsCallback(req: Request, res: Response): Promise<void> {
  const errorCode = String(req.query.error ?? "");
  if (errorCode) {
    res.status(400).send(renderErrorHtml("Permission denied", `Google returned error: ${escapeHtml(errorCode)}. Close this tab and click Connect again to retry.`));
    return;
  }
  const code = String(req.query.code ?? "");
  const rawState = String(req.query.state ?? "");
  if (!code) { res.status(400).send(renderErrorHtml("Missing code", "Google did not return ?code=")); return; }
  if (!rawState) { res.status(400).send(renderErrorHtml("Missing state", "Google did not return ?state=")); return; }

  const { data: rows, error: cErr } = await oauthCallbackClient(OAUTH_DB_REASON).rpc("consume_oauth_state", {
    p_provider: "google_sheets",
    p_state_hash: sha256Hex(rawState),
  });
  if (cErr) { res.status(500).send(renderErrorHtml("State consume failed", cErr.message)); return; }
  const tu = (rows as Array<{ tenant_id: string; user_id: string }> | null)?.[0];
  if (!tu) {
    res.status(403).send(renderErrorHtml("Invalid state", "OAuth state invalid, expired, or replayed. Close this tab and start over."));
    return;
  }

  let refreshToken: string;
  try {
    const exch = await exchangeCode(code);
    if (!exch.refresh_token) {
      res.status(400).send(renderErrorHtml(
        "Reconnect required",
        "Google did not return a refresh token (this happens when access was previously granted). " +
          "Revoke Zavi at <code>myaccount.google.com/permissions</code>, then close this tab and click Connect again.",
      ));
      return;
    }
    refreshToken = exch.refresh_token;
  } catch (e) {
    res.status(502).send(renderErrorHtml("Google API error", `Could not complete the Google handshake: ${escapeHtml((e as Error).message)}`));
    return;
  }

  const { error: setErr } = await oauthCallbackClient(OAUTH_DB_REASON).rpc("set_google_sheets_connection", {
    p_tenant_id: tu.tenant_id,
    p_refresh_token: refreshToken,
  });
  if (setErr) { res.status(500).send(renderErrorHtml("Persist failed", setErr.message)); return; }
  void notifyFounderActivity({ event: "first_connector", tenant_id: tu.tenant_id, user_id: tu.user_id, details: { connector: "google_sheets" } });
  await syncActiveTenant(tu.user_id, tu.tenant_id);
  res.send(renderSuccessHtml(webOrigin()));
}

function htmlShell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)} — Zavi</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;max-width:520px;margin:48px auto;padding:0 24px;color:#0f172a}h1{font-size:20px;font-weight:600;margin:0 0 12px}p{line-height:1.55;color:#334155;font-size:14.5px}code{background:#f1f5f9;padding:1px 6px;border-radius:4px;font-size:13px}button{background:#0f172a;color:#fff;border:0;border-radius:8px;padding:10px 16px;font-size:14px;font-weight:500;cursor:pointer}.muted{color:#64748b;font-size:13px}</style></head><body>${body}</body></html>`;
}
function renderErrorHtml(title: string, message: string): string {
  return htmlShell(title, `<h1>${escapeHtml(title)}</h1><p>${message}</p><p class="muted">You can close this tab.</p><button onclick="window.close()">Close tab</button>`);
}
function renderSuccessHtml(absWebOrigin: string): string {
  const target = `${absWebOrigin}/workspace?tab=settings&google_sheets=connected`;
  return htmlShell("Connected", `<h1>Connected to Google Sheets ✓</h1><p>Zavi can now read spreadsheets the connected Google account can open.</p><p class="muted">This tab will close automatically.</p><script>(function(){var t=${JSON.stringify(target)};try{if(window.opener&&!window.opener.closed){window.opener.location.href=t;window.close();return;}}catch(e){}window.location.href=t;})();</script>`);
}
