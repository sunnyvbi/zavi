import type { Request, Response } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { oauthCallbackClient } from "@/services/tenant-client";
import { syncActiveTenant } from "@/services/tenants/active-tenant";
import {
  googleSearchConsoleOAuthStartUrl,
  exchangeCode,
  listAccessibleSites,
  type GscSiteSummary,
} from "@/services/connectors/google-search-console/oauth";
import { resolveOwnedComposioAccount } from "@/services/connectors/composio/account";
import { notifyFounderActivity } from "@/services/tenants/founder-activity-alert";
import { logEvent } from "@/services/logging/logEvent";
import { googleOAuthErrorFailure, isGoogleScopeInsufficient, renderGoogleConnectFailHtml, type GoogleConnectFailure } from "@/services/connectors/google-connect-fail";

const OAUTH_DB_REASON = "google-search-console OAuth: pre-tenant state-nonce recovery + connection persist";

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

export async function googleSearchConsoleStart(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const rawState = crypto.randomBytes(32).toString("base64url");
  const { error } = await oauthCallbackClient(OAUTH_DB_REASON).rpc("mint_oauth_state", {
    p_provider: "google_search_console",
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
    const url = googleSearchConsoleOAuthStartUrl(rawState);
    if (wantsJson(req)) {
      res.json({ oauth_url: url });
      return;
    }
    res.redirect(302, url);
  } catch (e) {
    res.status(500).json({ error: { code: "google_search_console_misconfigured", message: (e as Error).message } });
  }
}

export async function googleSearchConsoleCallback(req: Request, res: Response): Promise<void> {
  const errorCode = String(req.query.error ?? "");
  if (errorCode) {
    res.status(400).send(fail(googleOAuthErrorFailure(errorCode)));
    return;
  }
  const code = String(req.query.code ?? "");
  const rawState = String(req.query.state ?? "");
  if (!code) { res.status(400).send(fail("missing_params")); return; }
  if (!rawState) { res.status(400).send(fail("missing_params")); return; }

  const { data: rows, error: cErr } = await oauthCallbackClient(OAUTH_DB_REASON).rpc("consume_oauth_state", {
    p_provider: "google_search_console",
    p_state_hash: sha256Hex(rawState),
  });
  if (cErr) { res.status(500).send(fail("state_consume_failed")); return; }
  const tu = (rows as Array<{ tenant_id: string; user_id: string }> | null)?.[0];
  if (!tu) {
    res.status(403).send(fail("invalid_state"));
    return;
  }

  let refreshToken: string;
  let sites: GscSiteSummary[];
  try {
    const exch = await exchangeCode(code);
    if (!exch.refresh_token) {
      res.status(400).send(fail("reconnect_required"));
      return;
    }
    refreshToken = exch.refresh_token;
    sites = await listAccessibleSites(exch.access_token);
  } catch (e) {
    void logEvent({
      level: "warn",
      source: "google_search_console.connect",
      code: "google_api_error",
      message: (e as Error).message,
      tenant_id: tu.tenant_id,
      meta: { connector_slug: "google_search_console" },
    });
    res.status(502).send(fail("google_api_error"));
    return;
  }

  await persistOrPick(tu, refreshToken, sites, res);
}

async function persistOrPick(
  tu: { tenant_id: string; user_id: string },
  refreshToken: string,
  sites: GscSiteSummary[],
  res: Response,
): Promise<void> {
  if (sites.length === 0) {
    res.status(400).send(fail("no_sites"));
    return;
  }

  if (sites.length === 1) {
    const { error: setErr } = await oauthCallbackClient(OAUTH_DB_REASON).rpc("set_google_search_console_connection", {
      p_tenant_id: tu.tenant_id,
      p_refresh_token: refreshToken,
      p_site_url: sites[0].site_url,
    });
    if (setErr) { res.status(500).send(fail("persist_failed")); return; }
    void notifyFounderActivity({ event: "first_connector", tenant_id: tu.tenant_id, user_id: tu.user_id, details: { connector: "google_search_console" } });
    await syncActiveTenant(tu.user_id, tu.tenant_id);
    res.send(renderSuccessHtml(webOrigin()));
    return;
  }

  const { data: inserted, error: insErr } = await oauthCallbackClient(OAUTH_DB_REASON)
    .from("google_search_console_pending_connections")
    .insert({
      tenant_id: tu.tenant_id,
      user_id: tu.user_id,
      refresh_token: refreshToken,
      site_urls: sites.map((s) => s.site_url),
    })
    .select("id")
    .single();
  if (insErr || !inserted) {
    res.status(500).send(fail("stash_failed"));
    return;
  }
  res.send(renderPickerHtml(inserted.id, sites, webOrigin()));
}

export async function completeGoogleSearchConsoleComposioConnect(
  tu: { tenant_id: string; user_id: string },
  _connectedAccountId: string,
  res: Response,
): Promise<"done" | "scope_missing"> {
  let sites: GscSiteSummary[];
  try {
    const account = await resolveOwnedComposioAccount(tu.tenant_id, "google_search_console");
    if (!account) throw new Error("the Composio connection was not found for this workspace");
    sites = await listAccessibleSites({ kind: "composio", account });
  } catch (e) {
    const scopeMissing = isGoogleScopeInsufficient((e as Error).message);
    void logEvent({
      level: "warn",
      source: "google_search_console.connect",
      code: scopeMissing ? "google_scope_missing" : "google_api_error",
      message: (e as Error).message,
      tenant_id: tu.tenant_id,
      meta: { connector_slug: "google_search_console" },
    });
    if (scopeMissing) return "scope_missing";
    res.status(502).send(fail("google_api_error"));
    return "done";
  }
  await persistOrPick(tu, "", sites, res);
  return "done";
}

const FinalizeBody = z.object({
  pending_id: z.string().uuid(),
  site_url: z.string().min(1).max(500),
});

export async function googleSearchConsoleFinalize(req: Request, res: Response): Promise<void> {
  const parsed = FinalizeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "invalid_input", message: parsed.error.message } });
    return;
  }
  const { data: rows, error: consumeErr } = await oauthCallbackClient(OAUTH_DB_REASON).rpc("consume_google_search_console_pending", {
    p_id: parsed.data.pending_id,
  });
  if (consumeErr) {
    res.status(500).json({ error: { code: "pending_consume_failed", message: consumeErr.message } });
    return;
  }
  const row = (rows as Array<{ tenant_id: string; user_id: string; refresh_token: string; site_urls: string[] }> | null)?.[0];
  if (!row) {
    res.status(400).json({ error: { code: "pending_expired_or_consumed", message: "Picker session expired or already used. Click Connect to start over." } });
    return;
  }
  if (!row.site_urls.includes(parsed.data.site_url)) {
    res.status(400).json({ error: { code: "invalid_site_for_pending", message: "Picked site was not in the stashed allowlist. Click Connect to start over." } });
    return;
  }
  const { error: setErr } = await oauthCallbackClient(OAUTH_DB_REASON).rpc("set_google_search_console_connection", {
    p_tenant_id: row.tenant_id,
    p_refresh_token: row.refresh_token,
    p_site_url: parsed.data.site_url,
  });
  if (setErr) {
    res.status(500).json({ error: { code: "set_google_search_console_connection_failed", message: setErr.message } });
    return;
  }
  void notifyFounderActivity({ event: "first_connector", tenant_id: row.tenant_id, user_id: row.user_id, details: { connector: "google_search_console" } });
  await syncActiveTenant(row.user_id, row.tenant_id);
  res.json({ ok: true, connected: { slug: "google_search_console", site_url: parsed.data.site_url } });
}

function htmlShell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)} — Zavi</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;max-width:520px;margin:48px auto;padding:0 24px;color:#0f172a}h1{font-size:20px;font-weight:600;margin:0 0 12px}p{line-height:1.55;color:#334155;font-size:14.5px}code{background:#f1f5f9;padding:1px 6px;border-radius:4px;font-size:13px}button{background:#0f172a;color:#fff;border:0;border-radius:8px;padding:10px 16px;font-size:14px;font-weight:500;cursor:pointer}.muted{color:#64748b;font-size:13px}.account-list{margin:24px 0;padding:0;list-style:none}.account-list li{padding:12px 0;border-bottom:1px solid #e2e8f0}.account-list li:last-child{border-bottom:0}.account-list label{display:flex;gap:10px;align-items:flex-start;cursor:pointer}.err{color:#b91c1c;margin-top:16px;font-size:13.5px}</style></head><body>${body}</body></html>`;
}
function fail(code: GoogleConnectFailure): string {
  return renderGoogleConnectFailHtml("google_search_console", code);
}
function renderSuccessHtml(absWebOrigin: string): string {
  const target = `${absWebOrigin}/workspace?tab=settings&google_search_console=connected`;
  return htmlShell("Connected", `<h1>Connected to Google Search Console ✓</h1><p>Zavi can now read what people search on Google to find you.</p><p class="muted">This tab will close automatically.</p><script>(function(){var t=${JSON.stringify(target)};try{if(window.opener&&!window.opener.closed){window.opener.location.href=t;window.close();return;}}catch(e){}window.location.href=t;})();</script>`);
}
function renderPickerHtml(pendingId: string, sites: GscSiteSummary[], absWebOrigin: string): string {
  const target = `${absWebOrigin}/workspace?tab=settings&google_search_console=connected`;
  const rows = sites
    .map((s) => `<li><label><input type="radio" name="site_url" value="${escapeHtml(s.site_url)}" required><span><strong>${escapeHtml(s.site_url)}</strong><br><span class="muted">${escapeHtml(s.permission_level)}</span></span></label></li>`)
    .join("\n");
  return htmlShell("Pick a Search Console property", `<h1>Pick the Search Console property to connect</h1><p>Your Google login has access to multiple Search Console properties. Pick the one Zavi should read. You can re-run this flow to switch later.</p><form id="f"><input type="hidden" name="pending_id" value="${escapeHtml(pendingId)}"><ul class="account-list">${rows}</ul><button type="submit">Connect this property</button><p id="err" class="err"></p></form><script>(function(){var t=${JSON.stringify(target)};document.getElementById("f").addEventListener("submit",async function(e){e.preventDefault();var fd=new FormData(e.target);var r;try{r=await fetch("/api/connectors/google-search-console/finalize",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({pending_id:fd.get("pending_id"),site_url:fd.get("site_url")})});}catch(err){document.getElementById("err").textContent="Network error: "+err.message;return;}if(r.ok){try{if(window.opener&&!window.opener.closed){window.opener.location.href=t;window.close();return;}}catch(e){}window.location.href=t;return;}var b;try{b=await r.json();}catch(_){b={error:{message:r.statusText}};}document.getElementById("err").textContent="Connection failed: "+((b&&b.error&&b.error.message)||("HTTP "+r.status));});})();</script>`);
}
