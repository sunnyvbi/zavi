
import type { Request, Response } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { serviceClient } from "@/services/supabase";
import { syncActiveTenant } from "@/services/tenants/active-tenant";
import {
  forgetGoogleAdsAccessToken,
  setGoogleAdsTokenExpiry,
} from "@/services/tools/google-ads/_client";
import {
  googleAdsOAuthStartUrl,
  exchangeCode,
  discoverAdsAccounts,
  type GoogleAdsDiscoveredAccount,
} from "@/services/connectors/google-ads/oauth";
import { notifyFounderActivity } from "@/services/tenants/founder-activity-alert";
import { nudgeAdBudgetReadAfterReconnect } from "@/services/decisions/ad-budget-reconnect-nudge";

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

export async function googleAdsStart(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const rawState = crypto.randomBytes(32).toString("base64url");
  const { error } = await serviceClient().rpc("mint_oauth_state", {
    p_provider: "google_ads",
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
    const url = googleAdsOAuthStartUrl(rawState);
    if (wantsJson(req)) {
      res.json({ oauth_url: url });
      return;
    }
    res.redirect(302, url);
  } catch (e) {
    res.status(500).json({ error: { code: "google_ads_misconfigured", message: (e as Error).message } });
  }
}

export async function googleAdsCallback(req: Request, res: Response): Promise<void> {
  const errorCode = String(req.query.error ?? "");
  if (errorCode) {
    res.status(400).send(renderErrorHtml("Permission denied", `Google returned error: ${escapeHtml(errorCode)}. Close this tab and click Connect again to retry.`));
    return;
  }
  const code = String(req.query.code ?? "");
  const rawState = String(req.query.state ?? "");
  if (!code) { res.status(400).send(renderErrorHtml("Missing code", "Google did not return ?code=")); return; }
  if (!rawState) { res.status(400).send(renderErrorHtml("Missing state", "Google did not return ?state=")); return; }

  const { data: rows, error: cErr } = await serviceClient().rpc("consume_oauth_state", {
    p_provider: "google_ads",
    p_state_hash: sha256Hex(rawState),
  });
  if (cErr) { res.status(500).send(renderErrorHtml("State consume failed", cErr.message)); return; }
  const tu = (rows as Array<{ tenant_id: string; user_id: string }> | null)?.[0];
  if (!tu) {
    res.status(403).send(renderErrorHtml("Invalid state", "OAuth state invalid, expired, or replayed. Close this tab and start over."));
    return;
  }

  let refreshToken: string;
  let accounts: GoogleAdsDiscoveredAccount[];
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
    accounts = await discoverAdsAccounts(exch.access_token);
  } catch (e) {
    res.status(502).send(renderErrorHtml("Google API error", `Could not complete the Google handshake: ${escapeHtml((e as Error).message)}`));
    return;
  }

  if (accounts.length === 0) {
    res.status(400).send(renderErrorHtml(
      "No accessible Google Ads accounts",
      "Your Google account has no accessible Google Ads customers. Confirm you have access to a Google Ads account, then close this tab and click Connect again.",
    ));
    return;
  }

  if (accounts.length === 1) {
    const { error: setErr } = await serviceClient().rpc("set_google_ads_connection", {
      p_tenant_id: tu.tenant_id,
      p_refresh_token: refreshToken,
      p_customer_id: accounts[0].customer_id,
      p_login_customer_id: accounts[0].login_customer_id,
    });
    if (setErr) { res.status(500).send(renderErrorHtml("Persist failed", setErr.message)); return; }
    forgetGoogleAdsAccessToken(tu.tenant_id);
    await setGoogleAdsTokenExpiry(tu.tenant_id, null);
    nudgeAdBudgetReadAfterReconnect(tu.tenant_id);
    void notifyFounderActivity({ event: "first_connector", tenant_id: tu.tenant_id, user_id: tu.user_id, details: { connector: "google_ads" } });
    await syncActiveTenant(tu.user_id, tu.tenant_id);
    res.send(renderSuccessHtml(webOrigin()));
    return;
  }

  const { data: inserted, error: insErr } = await serviceClient()
    .from("google_ads_pending_connections")
    .insert({
      tenant_id: tu.tenant_id,
      user_id: tu.user_id,
      refresh_token: refreshToken,
      customer_ids: accounts.map((a) => a.customer_id),
      accounts,
    })
    .select("id")
    .single();
  if (insErr || !inserted) {
    res.status(500).send(renderErrorHtml("Stash failed", `Could not stage the picker: ${escapeHtml(insErr?.message ?? "no row")}`));
    return;
  }
  res.send(renderPickerHtml(inserted.id, accounts, webOrigin()));
}

const FinalizeBody = z.object({
  pending_id: z.string().uuid(),
  customer_id: z.string().regex(/^\d{1,20}$/, "customer_id must be digits"),
});

export async function googleAdsFinalize(req: Request, res: Response): Promise<void> {
  const parsed = FinalizeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "invalid_input", message: parsed.error.message } });
    return;
  }
  const { data: rows, error: consumeErr } = await serviceClient().rpc("consume_google_ads_pending", {
    p_id: parsed.data.pending_id,
  });
  if (consumeErr) {
    res.status(500).json({ error: { code: "pending_consume_failed", message: consumeErr.message } });
    return;
  }
  const row = (rows as Array<{
    tenant_id: string;
    user_id: string;
    refresh_token: string;
    customer_ids: string[];
    accounts: Array<{ customer_id: string; login_customer_id: string | null }> | null;
  }> | null)?.[0];
  if (!row) {
    res.status(400).json({ error: { code: "pending_expired_or_consumed", message: "Picker session expired or already used. Click Connect to start over." } });
    return;
  }
  const picked = (row.accounts ?? []).find((a) => a.customer_id === parsed.data.customer_id);
  if (!picked && !row.customer_ids.includes(parsed.data.customer_id)) {
    res.status(400).json({ error: { code: "invalid_customer_for_pending", message: "Picked customer was not in the stashed allowlist. Click Connect to start over." } });
    return;
  }
  const { error: setErr } = await serviceClient().rpc("set_google_ads_connection", {
    p_tenant_id: row.tenant_id,
    p_refresh_token: row.refresh_token,
    p_customer_id: parsed.data.customer_id,
    p_login_customer_id: picked?.login_customer_id ?? null,
  });
  if (setErr) {
    res.status(500).json({ error: { code: "set_google_ads_connection_failed", message: setErr.message } });
    return;
  }
  forgetGoogleAdsAccessToken(row.tenant_id);
  await setGoogleAdsTokenExpiry(row.tenant_id, null);
  nudgeAdBudgetReadAfterReconnect(row.tenant_id);
  void notifyFounderActivity({ event: "first_connector", tenant_id: row.tenant_id, user_id: row.user_id, details: { connector: "google_ads" } });
  await syncActiveTenant(row.user_id, row.tenant_id);
  res.json({ ok: true, connected: { slug: "google_ads", customer_id: parsed.data.customer_id } });
}

function htmlShell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)} — Zavi</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;max-width:520px;margin:48px auto;padding:0 24px;color:#0f172a}h1{font-size:20px;font-weight:600;margin:0 0 12px}p{line-height:1.55;color:#334155;font-size:14.5px}code{background:#f1f5f9;padding:1px 6px;border-radius:4px;font-size:13px}button{background:#0f172a;color:#fff;border:0;border-radius:8px;padding:10px 16px;font-size:14px;font-weight:500;cursor:pointer}.muted{color:#64748b;font-size:13px}.account-list{margin:24px 0;padding:0;list-style:none}.account-list li{padding:12px 0;border-bottom:1px solid #e2e8f0}.account-list li:last-child{border-bottom:0}.account-list label{display:flex;gap:10px;align-items:flex-start;cursor:pointer}.err{color:#b91c1c;margin-top:16px;font-size:13.5px}</style></head><body>${body}</body></html>`;
}
function renderErrorHtml(title: string, message: string): string {
  return htmlShell(title, `<h1>${escapeHtml(title)}</h1><p>${message}</p><p class="muted">You can close this tab.</p><button onclick="window.close()">Close tab</button>`);
}
function renderSuccessHtml(absWebOrigin: string): string {
  const target = `${absWebOrigin}/workspace?tab=settings&google_ads=connected`;
  return htmlShell("Connected", `<h1>Connected to Google Ads ✓</h1><p>Zavi can now read your campaigns to plan and report on your ads.</p><p class="muted">This tab will close automatically.</p><script>(function(){var t=${JSON.stringify(target)};try{if(window.opener&&!window.opener.closed){window.opener.location.href=t;window.close();return;}}catch(e){}window.location.href=t;})();</script>`);
}
function renderPickerHtml(pendingId: string, accounts: GoogleAdsDiscoveredAccount[], absWebOrigin: string): string {
  const target = `${absWebOrigin}/workspace?tab=settings&google_ads=connected`;
  const rows = accounts
    .map((a) => {
      const label = a.descriptive_name
        ? `<strong>${escapeHtml(a.descriptive_name)}</strong> <span class="muted">${escapeHtml(a.customer_id)}</span>`
        : `<strong>${escapeHtml(a.customer_id)}</strong>`;
      const via = a.login_customer_id
        ? `<br><span class="muted">via manager account ${escapeHtml(a.login_customer_id)}</span>`
        : "";
      return `<li><label><input type="radio" name="customer_id" value="${escapeHtml(a.customer_id)}" required><span>${label}${via}</span></label></li>`;
    })
    .join("\n");
  return htmlShell("Pick a Google Ads account", `<h1>Pick the Google Ads account to connect</h1><p>Your Google login has access to multiple Google Ads accounts. Pick the one Zavi should read. You can re-run this flow to switch later.</p><form id="f"><input type="hidden" name="pending_id" value="${escapeHtml(pendingId)}"><ul class="account-list">${rows}</ul><button type="submit">Connect this account</button><p id="err" class="err"></p></form><script>(function(){var t=${JSON.stringify(target)};document.getElementById("f").addEventListener("submit",async function(e){e.preventDefault();var fd=new FormData(e.target);var r;try{r=await fetch("/api/connectors/google-ads/finalize",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({pending_id:fd.get("pending_id"),customer_id:fd.get("customer_id")})});}catch(err){document.getElementById("err").textContent="Network error: "+err.message;return;}if(r.ok){try{if(window.opener&&!window.opener.closed){window.opener.location.href=t;window.close();return;}}catch(e){}window.location.href=t;return;}var b;try{b=await r.json();}catch(_){b={error:{message:r.statusText}};}document.getElementById("err").textContent="Connection failed: "+((b&&b.error&&b.error.message)||("HTTP "+r.status));});})();</script>`);
}
