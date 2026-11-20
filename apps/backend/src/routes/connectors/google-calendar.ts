
import type { Request, Response } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { oauthCallbackClient } from "@/services/tenant-client";
import { syncActiveTenant } from "@/services/tenants/active-tenant";
import {
  googleCalendarOAuthStartUrl,
  exchangeCode,
  listAccessibleCalendars,
  type GoogleCalendarSummary,
} from "@/services/connectors/google-calendar/oauth";
import { notifyFounderActivity } from "@/services/tenants/founder-activity-alert";

const OAUTH_DB_REASON = "google-calendar OAuth: pre-tenant state-nonce recovery + connection persist";

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

export async function googleCalendarStart(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const rawState = crypto.randomBytes(32).toString("base64url");
  const { error } = await oauthCallbackClient(OAUTH_DB_REASON).rpc("mint_oauth_state", {
    p_provider: "google_calendar",
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
    const url = googleCalendarOAuthStartUrl(rawState);
    if (wantsJson(req)) {
      res.json({ oauth_url: url });
      return;
    }
    res.redirect(302, url);
  } catch (e) {
      console.error("google_calendar_misconfigured", (e as Error).message);
    res.status(500).json({ error: { code: "google_calendar_misconfigured", message: "This integration is not configured yet. Zavi has been notified." } });
  }
}

export async function googleCalendarCallback(req: Request, res: Response): Promise<void> {
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
    p_provider: "google_calendar",
    p_state_hash: sha256Hex(rawState),
  });
  if (cErr) { res.status(500).send(renderErrorHtml("State consume failed", cErr.message)); return; }
  const tu = (rows as Array<{ tenant_id: string; user_id: string }> | null)?.[0];
  if (!tu) {
    res.status(403).send(renderErrorHtml("Invalid state", "OAuth state invalid, expired, or replayed. Close this tab and start over."));
    return;
  }

  let refreshToken: string;
  let accessToken: string;
  let calendars: GoogleCalendarSummary[];
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
    accessToken = exch.access_token;
    calendars = await listAccessibleCalendars(accessToken);
  } catch (e) {
    res.status(502).send(renderErrorHtml("Google API error", `Could not complete the Google handshake: ${escapeHtml((e as Error).message)}`));
    return;
  }

  if (calendars.length === 0) {
    res.status(400).send(renderErrorHtml(
      "No accessible Google calendars",
      "Your Google account has no accessible calendars. Confirm you have access to a Google Calendar, then close this tab and click Connect again.",
    ));
    return;
  }

  const primaryOnly = calendars.filter((c) => c.primary);
  if (primaryOnly.length === 1 && calendars.length > 1) {
    const { error: setErr } = await oauthCallbackClient(OAUTH_DB_REASON).rpc("set_google_calendar_connection", {
      p_tenant_id: tu.tenant_id,
      p_refresh_token: refreshToken,
      p_calendar_id: primaryOnly[0].calendar_id,
    });
    if (setErr) { res.status(500).send(renderErrorHtml("Persist failed", setErr.message)); return; }
    void notifyFounderActivity({ event: "first_connector", tenant_id: tu.tenant_id, user_id: tu.user_id, details: { connector: "google_calendar" } });
    await syncActiveTenant(tu.user_id, tu.tenant_id);
    res.send(renderSuccessHtml(webOrigin()));
    return;
  }

  if (calendars.length === 1) {
    const { error: setErr } = await oauthCallbackClient(OAUTH_DB_REASON).rpc("set_google_calendar_connection", {
      p_tenant_id: tu.tenant_id,
      p_refresh_token: refreshToken,
      p_calendar_id: calendars[0].calendar_id,
    });
    if (setErr) { res.status(500).send(renderErrorHtml("Persist failed", setErr.message)); return; }
    void notifyFounderActivity({ event: "first_connector", tenant_id: tu.tenant_id, user_id: tu.user_id, details: { connector: "google_calendar" } });
    await syncActiveTenant(tu.user_id, tu.tenant_id);
    res.send(renderSuccessHtml(webOrigin()));
    return;
  }

  const { data: inserted, error: insErr } = await oauthCallbackClient(OAUTH_DB_REASON)
    .from("google_calendar_pending_connections")
    .insert({
      tenant_id: tu.tenant_id,
      user_id: tu.user_id,
      refresh_token: refreshToken,
      calendar_ids: calendars.map((c) => c.calendar_id),
    })
    .select("id")
    .single();
  if (insErr || !inserted) {
    res.status(500).send(renderErrorHtml("Stash failed", "Could not stage the picker. Close this tab and click Connect again."));
    return;
  }
  res.send(renderPickerHtml(inserted.id, calendars, webOrigin()));
}

const FinalizeBody = z.object({
  pending_id: z.string().uuid(),
  calendar_id: z.string().min(1).max(512),
});

export async function googleCalendarFinalize(req: Request, res: Response): Promise<void> {
  const parsed = FinalizeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "invalid_input", message: parsed.error.message } });
    return;
  }
  const { data: rows, error: consumeErr } = await oauthCallbackClient(OAUTH_DB_REASON).rpc("consume_google_calendar_pending", {
    p_id: parsed.data.pending_id,
  });
  if (consumeErr) {
    res.status(500).json({ error: { code: "pending_consume_failed", message: consumeErr.message } });
    return;
  }
  const row = (rows as Array<{ tenant_id: string; user_id: string; refresh_token: string; calendar_ids: string[] }> | null)?.[0];
  if (!row) {
    res.status(400).json({ error: { code: "pending_expired_or_consumed", message: "Picker session expired or already used. Click Connect to start over." } });
    return;
  }
  if (!row.calendar_ids.includes(parsed.data.calendar_id)) {
    res.status(400).json({ error: { code: "invalid_calendar_for_pending", message: "Picked calendar was not in the stashed allowlist. Click Connect to start over." } });
    return;
  }
  const { error: setErr } = await oauthCallbackClient(OAUTH_DB_REASON).rpc("set_google_calendar_connection", {
    p_tenant_id: row.tenant_id,
    p_refresh_token: row.refresh_token,
    p_calendar_id: parsed.data.calendar_id,
  });
  if (setErr) {
    res.status(500).json({ error: { code: "set_google_calendar_connection_failed", message: setErr.message } });
    return;
  }
  void notifyFounderActivity({ event: "first_connector", tenant_id: row.tenant_id, user_id: row.user_id, details: { connector: "google_calendar" } });
  await syncActiveTenant(row.user_id, row.tenant_id);
  res.json({ ok: true, connected: { slug: "google_calendar", calendar_id: parsed.data.calendar_id } });
}

function htmlShell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)} — Zavi</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;max-width:520px;margin:48px auto;padding:0 24px;color:#0f172a}h1{font-size:20px;font-weight:600;margin:0 0 12px}p{line-height:1.55;color:#334155;font-size:14.5px}code{background:#f1f5f9;padding:1px 6px;border-radius:4px;font-size:13px}button{background:#0f172a;color:#fff;border:0;border-radius:8px;padding:10px 16px;font-size:14px;font-weight:500;cursor:pointer}.muted{color:#64748b;font-size:13px}.account-list{margin:24px 0;padding:0;list-style:none}.account-list li{padding:12px 0;border-bottom:1px solid #e2e8f0}.account-list li:last-child{border-bottom:0}.account-list label{display:flex;gap:10px;align-items:flex-start;cursor:pointer}.err{color:#b91c1c;margin-top:16px;font-size:13.5px}</style></head><body>${body}</body></html>`;
}
function renderErrorHtml(title: string, message: string): string {
  return htmlShell(title, `<h1>${escapeHtml(title)}</h1><p>${message}</p><p class="muted">You can close this tab.</p><button onclick="window.close()">Close tab</button>`);
}
function renderSuccessHtml(absWebOrigin: string): string {
  const target = `${absWebOrigin}/workspace?tab=settings&google_calendar=connected`;
  return htmlShell("Connected", `<h1>Connected to Google Calendar ✓</h1><p>Zavi can now read your calendar.</p><p class="muted">This tab will close automatically.</p><script>(function(){var t=${JSON.stringify(target)};try{if(window.opener&&!window.opener.closed){window.opener.location.href=t;window.close();return;}}catch(e){}window.location.href=t;})();</script>`);
}
function renderPickerHtml(pendingId: string, calendars: GoogleCalendarSummary[], absWebOrigin: string): string {
  const target = `${absWebOrigin}/workspace?tab=settings&google_calendar=connected`;
  const rows = calendars
    .map((c) => `<li><label><input type="radio" name="calendar_id" value="${escapeHtml(c.calendar_id)}" required><span><strong>${escapeHtml(c.display_name)}</strong>${c.primary ? ' <span class="muted">(primary)</span>' : ""}<br><span class="muted">${escapeHtml(c.calendar_id)}</span></span></label></li>`)
    .join("\n");
  return htmlShell("Pick a Google Calendar", `<h1>Pick the Google Calendar to connect</h1><p>Your Google login has access to multiple calendars. Pick the one Zavi should read. You can re-run this flow to switch later.</p><form id="f"><input type="hidden" name="pending_id" value="${escapeHtml(pendingId)}"><ul class="account-list">${rows}</ul><button type="submit">Connect this calendar</button><p id="err" class="err"></p></form><script>(function(){var t=${JSON.stringify(target)};document.getElementById("f").addEventListener("submit",async function(e){e.preventDefault();var fd=new FormData(e.target);var r;try{r=await fetch("/api/connectors/google-calendar/finalize",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({pending_id:fd.get("pending_id"),calendar_id:fd.get("calendar_id")})});}catch(err){document.getElementById("err").textContent="Network error: "+err.message;return;}if(r.ok){try{if(window.opener&&!window.opener.closed){window.opener.location.href=t;window.close();return;}}catch(e){}window.location.href=t;return;}var b;try{b=await r.json();}catch(_){b={error:{message:r.statusText}};}document.getElementById("err").textContent="Connection failed: "+((b&&b.error&&b.error.message)||("HTTP "+r.status));});})();</script>`);
}
