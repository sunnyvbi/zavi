
import type { Request, Response } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { serviceClient } from "@/services/supabase";
import { serverClientFromBearer } from "@/services/supabase";
import { syncActiveTenant } from "@/services/tenants/active-tenant";
import {
  metaOAuthStartUrl,
  exchangeCode,
  exchangeForLongLivedToken,
  listAdAccounts,
  verifyAccountReadable,
  type MetaAdAccount,
} from "@/services/connectors/meta-ads/oauth";
import {
  resolveTokenExpiry,
  persistMetaAdsExpiry,
} from "@/services/connectors/meta-ads/expiry";
import { verifySignedRequest } from "@/services/connectors/meta-ads/signed-request";
import { logEvent } from "@/services/logging/logEvent";
import { track } from "@/services/analytics/mixpanel";
import { inngest } from "@/../workers/client";
import { handleConnectorAccountSwap, priorConnectorTeamId } from "@/services/connectors/core/token";
import { notifyFounderActivity } from "@/services/tenants/founder-activity-alert";
import { autoSetCompanyCountryInBackground } from "@/services/company/country-inference";
import { resolveMetaAdCapability } from "@/services/tools/meta-ads/write/_library-ad-capability";
import { noteMetaReadiness } from "@/services/growth/ad-account-watch";
import { forgetMetaAdsCreds } from "@/services/tools/meta-ads/_client";
import { forgetMetaScopes } from "@/services/tools/meta-ads/_scopes";
import { nudgeAdBudgetReadAfterReconnect } from "@/services/decisions/ad-budget-reconnect-nudge";

export function forgetCachedMetaConnection(tenant_id: string): void {
  forgetMetaAdsCreds(tenant_id);
  forgetMetaScopes(tenant_id);
}

export const READINESS_RECHECK_TIMEOUT_MS = 4000;

export async function recheckMetaReadinessAfterConnect(tenant_id: string, timeoutMs = READINESS_RECHECK_TIMEOUT_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        const cap = await resolveMetaAdCapability(tenant_id);
        await noteMetaReadiness(tenant_id, cap.ok ? null : cap.reason_code);
      })(),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } catch (e) {
    console.warn(`[meta-ads connect] readiness re-check for ${tenant_id}: ${(e as Error).message}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function webOrigin(): string {
  return (process.env.WEB_ORIGIN || "http://localhost:3000").split(",")[0].trim();
}

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function wantsJson(req: Request): boolean {
  const accept = String(req.headers["accept"] ?? "");
  return accept.includes("application/json");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function metaAdsStart(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const rawState = crypto.randomBytes(32).toString("base64url");
  const stateHash = sha256Hex(rawState);

  const { error } = await serviceClient().rpc("mint_oauth_state", {
    p_provider: "meta_ads",
    p_tenant_id: auth.tenant_id,
    p_user_id: auth.user_id,
    p_state_hash: stateHash,
    p_ttl_seconds: 600,
  });
  if (error) {
    res.status(500).json({
      error: { code: "state_mint_failed", message: error.message },
    });
    return;
  }

  try {
    const url = metaOAuthStartUrl(rawState);
    if (wantsJson(req)) {
      res.json({ oauth_url: url });
      return;
    }
    res.redirect(302, url);
  } catch (e) {
    res.status(500).json({
      error: { code: "meta_ads_misconfigured", message: (e as Error).message },
    });
  }
}

export async function metaAdsCallback(req: Request, res: Response): Promise<void> {
  const errorCode = String(req.query.error ?? "");
  if (errorCode) {
    res.status(400).send(renderErrorHtml(
      "Permission denied",
      `Facebook returned error: ${escapeHtml(errorCode)}. Close this tab and click Connect Ad Account again to retry.`,
    ));
    return;
  }

  const code = String(req.query.code ?? "");
  const rawState = String(req.query.state ?? "");
  if (!code) {
    res.status(400).send(renderErrorHtml("Missing code", "Facebook did not return ?code="));
    return;
  }
  if (!rawState) {
    res.status(400).send(renderErrorHtml("Missing state", "Facebook did not return ?state="));
    return;
  }

  const stateHash = sha256Hex(rawState);
  const { data: rows, error: cErr } = await serviceClient().rpc(
    "consume_oauth_state",
    { p_provider: "meta_ads", p_state_hash: stateHash },
  );
  if (cErr) {
    res.status(500).send(renderErrorHtml("State consume failed", cErr.message));
    return;
  }
  const tenantUser = (rows as Array<{ tenant_id: string; user_id: string }> | null)?.[0];
  if (!tenantUser) {
    res.status(403).send(renderErrorHtml(
      "Invalid state",
      "OAuth state invalid, expired, or replayed. Close this tab and start over.",
    ));
    return;
  }

  let longToken: string;
  let longTokenExpiresIn: number | undefined;
  let accounts: MetaAdAccount[];
  try {
    const exch = await exchangeCode(code);
    const longLived = await exchangeForLongLivedToken(exch.access_token);
    longToken = longLived.access_token;
    longTokenExpiresIn = longLived.expires_in;
    accounts = await listAdAccounts(longToken);
  } catch (e) {
    res.status(502).send(renderErrorHtml(
      "Meta API error",
      `Could not complete the Facebook handshake: ${escapeHtml((e as Error).message)}`,
    ));
    return;
  }

  if (accounts.length === 0) {
    res.status(400).send(renderErrorHtml(
      "No ad accounts",
      "Your Facebook account does not have <code>ads_management</code> access to any ACTIVE ad accounts. " +
        "In Meta Business Settings → Users → People, assign at least one ad account to your user. " +
        "Then close this tab and click Connect Ad Account again.",
    ));
    return;
  }

  if (accounts.length === 1) {
    try {
      await verifyAccountReadable(longToken, accounts[0].id);
    } catch (e) {
      res.status(400).send(renderErrorHtml(
        "Account not readable",
        `Your token can list ad account <code>${escapeHtml(accounts[0].id)}</code> but cannot read its insights. ` +
          `Confirm the account is ACTIVE and your user has Advertise / Manage role. Details: ${escapeHtml((e as Error).message)}`,
      ));
      return;
    }
    const priorAccount = await priorConnectorTeamId(tenantUser.tenant_id, "meta_ads");
    const { error: setErr } = await serviceClient().rpc("set_meta_ads_connection", {
      p_tenant_id: tenantUser.tenant_id,
      p_access_token: longToken,
      p_ad_account_id: accounts[0].id,
    });
    if (setErr) {
      res.status(500).send(renderErrorHtml("Persist failed", setErr.message));
      return;
    }
    forgetCachedMetaConnection(tenantUser.tenant_id);
    if (priorAccount && priorAccount !== accounts[0].id) {
      await handleConnectorAccountSwap(tenantUser.tenant_id, "meta_ads");
    }
    autoSetCompanyCountryInBackground(tenantUser.tenant_id);
    await recheckMetaReadinessAfterConnect(tenantUser.tenant_id);
    nudgeAdBudgetReadAfterReconnect(tenantUser.tenant_id);
    const expiresAt = await resolveTokenExpiry(
      longToken,
      longTokenExpiresIn,
      tenantUser.tenant_id,
    );
    const pinned = await persistMetaAdsExpiry({
      tenant_id: tenantUser.tenant_id,
      access_token: longToken,
      expires_at: expiresAt,
    });
    if (!pinned) {
      res.status(500).send(renderErrorHtml(
        "Connected, but expiry not recorded",
        "Meta Ads is connected and usable, but we could not record when the token expires, " +
          "so you may not get an early warning before it lapses. The daily health check " +
          "repairs this automatically within 24 hours, no action needed unless it persists.",
      ));
      return;
    }
    void notifyFounderActivity({ event: "first_connector", tenant_id: tenantUser.tenant_id, user_id: tenantUser.user_id, details: { connector: "meta_ads" } });
    await syncActiveTenant(tenantUser.user_id, tenantUser.tenant_id);
    res.send(renderSuccessHtml(webOrigin()));
    return;
  }

  const { data: inserted, error: insErr } = await serviceClient()
    .from("meta_ads_pending_connections")
    .insert({
      tenant_id: tenantUser.tenant_id,
      user_id: tenantUser.user_id,
      long_token: longToken,
      account_ids: accounts.map((a) => a.id),
    })
    .select("id")
    .single();
  if (insErr || !inserted) {
    res.status(500).send(renderErrorHtml(
      "Stash failed",
      `Could not stage the picker payload: ${escapeHtml(insErr?.message ?? "no row returned")}`,
    ));
    return;
  }

  res.send(renderPickerHtml(inserted.id, accounts, webOrigin()));
}

const FinalizeBody = z.object({
  pending_id: z.string().uuid(),
  ad_account_id: z.string().regex(/^act_\d+$/, "ad_account_id must be act_<digits>"),
});

export async function metaAdsFinalize(req: Request, res: Response): Promise<void> {
  const parsed = FinalizeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: { code: "invalid_input", message: parsed.error.message },
    });
    return;
  }

  const { data: rows, error: consumeErr } = await serviceClient().rpc(
    "consume_meta_ads_pending",
    { p_id: parsed.data.pending_id },
  );
  if (consumeErr) {
    res.status(500).json({
      error: { code: "pending_consume_failed", message: consumeErr.message },
    });
    return;
  }
  const row = (rows as Array<{ tenant_id: string; long_token: string; account_ids: string[] }> | null)?.[0];
  if (!row) {
    res.status(400).json({
      error: { code: "pending_expired_or_consumed", message: "Picker session expired or already used. Click Connect Ad Account to start over." },
    });
    return;
  }

  if (!row.account_ids.includes(parsed.data.ad_account_id)) {
    res.status(400).json({
      error: {
        code: "invalid_ad_account_for_pending",
        message: "Picked ad account was not in the stashed allowlist. Click Connect Ad Account to start over.",
      },
    });
    return;
  }

  const priorPicked = await priorConnectorTeamId(row.tenant_id, "meta_ads");
  const { error: setErr } = await serviceClient().rpc("set_meta_ads_connection", {
    p_tenant_id: row.tenant_id,
    p_access_token: row.long_token,
    p_ad_account_id: parsed.data.ad_account_id,
  });
  if (setErr) {
    res.status(500).json({
      error: { code: "set_meta_ads_connection_failed", message: setErr.message },
    });
    return;
  }
  forgetCachedMetaConnection(row.tenant_id);
  if (priorPicked && priorPicked !== parsed.data.ad_account_id) {
    await handleConnectorAccountSwap(row.tenant_id, "meta_ads");
  }
  autoSetCompanyCountryInBackground(row.tenant_id);
  await recheckMetaReadinessAfterConnect(row.tenant_id);
  nudgeAdBudgetReadAfterReconnect(row.tenant_id);

  track("connector_connected", { tenant_id: row.tenant_id, connector: "meta_ads" });
  void notifyFounderActivity({ event: "first_connector", tenant_id: row.tenant_id, user_id: null, details: { connector: "meta_ads" } });

  const expiresAt = await resolveTokenExpiry(row.long_token, undefined, row.tenant_id);
  const pinned = await persistMetaAdsExpiry({
    tenant_id: row.tenant_id,
    access_token: row.long_token,
    expires_at: expiresAt,
  });

  res.json({
    ok: true,
    connected: { slug: "meta_ads", ad_account_id: parsed.data.ad_account_id },
    expiry_recorded: pinned,
  });
}

export async function metaAdsDisconnect(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const authHeader = (req.headers.authorization as string | undefined) ?? "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : authHeader;
  const sb = serverClientFromBearer(token);

  const { error } = await sb.rpc("disconnect_meta_ads", {
    p_tenant_id: auth.tenant_id,
  });
  if (error) {
    const code = (error as { code?: string }).code;
    if (code === "42501") {
      res.status(403).json({ error: { code: "not_admin", message: error.message } });
      return;
    }
    if (code === "PGRST202" || code === "42883") {
      res.status(500).json({
        error: {
          code: "rpc_missing",
          message:
            "Meta Ads disconnect is temporarily unavailable: a pending database migration has not been applied.",
        },
      });
      return;
    }
    res.status(500).json({ error: { code: "rpc_failed", message: error.message } });
    return;
  }
  res.status(200).json({ ok: true });
}

export async function metaAdsDeauthorize(req: Request, res: Response): Promise<void> {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) {
    res.status(503).json({
      error: {
        code: "meta_ads_misconfigured",
        message: "META_APP_SECRET is not set; cannot verify the signed request",
      },
    });
    return;
  }

  const raw = (req.body as { signed_request?: unknown } | undefined)?.signed_request;
  const verified = typeof raw === "string" ? verifySignedRequest(raw, appSecret) : null;
  if (!verified) {
    await logEvent({
      level: "warn",
      source: "meta_ads",
      code: "meta_ads.deauthorize_bad_signature",
      message: "Rejected a deauthorize callback whose signed_request did not verify",
      meta: { connector_slug: "meta_ads" },
    });
    res.status(401).json({
      error: {
        code: "invalid_signed_request",
        message: "signed_request missing, malformed, or not signed by this app",
      },
    });
    return;
  }

  try {
    await inngest.send({ name: "meta_ads.deauthorized", data: {} });
  } catch (e) {
    await logEvent({
      level: "error",
      source: "meta_ads",
      code: "meta_ads.deauthorize_dispatch_failed",
      error: e,
      meta: { connector_slug: "meta_ads" },
    });
    res.status(500).json({
      error: {
        code: "dispatch_failed",
        message: "Could not enqueue the connector health sweep",
      },
    });
    return;
  }

  await logEvent({
    level: "info",
    source: "meta_ads",
    code: "meta_ads.deauthorized",
    message: "Meta deauthorize callback verified; token-health sweep enqueued",
    meta: { connector_slug: "meta_ads" },
  });
  res.json({ ok: true });
}

function htmlShell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)} — Zavi</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; max-width: 520px; margin: 48px auto; padding: 0 24px; color: #0f172a; }
h1 { font-size: 20px; font-weight: 600; margin: 0 0 12px; }
p { line-height: 1.55; color: #334155; font-size: 14.5px; }
code { background: #f1f5f9; padding: 1px 6px; border-radius: 4px; font-size: 13px; }
button, .btn { background: #0f172a; color: white; border: 0; border-radius: 8px; padding: 10px 16px; font-size: 14px; font-weight: 500; cursor: pointer; }
.muted { color: #64748b; font-size: 13px; }
.account-list { margin: 24px 0; padding: 0; list-style: none; }
.account-list li { padding: 12px 0; border-bottom: 1px solid #e2e8f0; }
.account-list li:last-child { border-bottom: 0; }
.account-list label { display: flex; gap: 10px; align-items: flex-start; cursor: pointer; }
.account-list input { margin-top: 4px; }
.err { color: #b91c1c; margin-top: 16px; font-size: 13.5px; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function renderErrorHtml(title: string, message: string): string {
  return htmlShell(
    title,
    `<h1>${escapeHtml(title)}</h1>
<p>${message}</p>
<p class="muted">You can close this tab.</p>
<button onclick="window.close()">Close tab</button>`,
  );
}

function renderSuccessHtml(absWebOrigin: string): string {
  const target = `${absWebOrigin}/workspace?tab=settings&meta_ads=connected`;
  return htmlShell(
    "Connected",
    `<h1>Connected to Meta Ads ✓</h1>
<p>Your Facebook + Instagram ad account is wired up. Zavi can now read your campaigns to plan and report on your ads.</p>
<p class="muted">This tab will close automatically.</p>
<script>
(function () {
  var target = ${JSON.stringify(target)};
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.location.href = target;
      window.close();
      return;
    }
  } catch (e) { /* cross-origin opener access can throw; fall through */ }
  window.location.href = target;
})();
</script>`,
  );
}

function renderPickerHtml(
  pendingId: string,
  accounts: MetaAdAccount[],
  absWebOrigin: string,
): string {
  const target = `${absWebOrigin}/workspace?tab=settings&meta_ads=connected`;
  const rows = accounts
    .map(
      (a) => `<li>
  <label>
    <input type="radio" name="ad_account_id" value="${escapeHtml(a.id)}" required>
    <span>
      <strong>${escapeHtml(a.name)}</strong>
      <span class="muted"> — ${escapeHtml(a.id)} · ${escapeHtml(a.currency)}</span>
    </span>
  </label>
</li>`,
    )
    .join("\n");

  return htmlShell(
    "Pick an ad account",
    `<h1>Pick the ad account to connect</h1>
<p>Your Facebook user has access to multiple ad accounts. Pick the one you want Zavi to read. You can re-run this flow to switch accounts later.</p>
<form id="picker-form">
  <input type="hidden" name="pending_id" value="${escapeHtml(pendingId)}">
  <ul class="account-list">
    ${rows}
  </ul>
  <button type="submit">Connect this account</button>
  <p id="err" class="err"></p>
  <p id="notice" class="muted" hidden></p>
  <p hidden id="continue-wrap"><a id="continue" href="#">Continue to Zavi</a></p>
</form>
<script>
(function () {
  var target = ${JSON.stringify(target)};
  document.getElementById("picker-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    var fd = new FormData(e.target);
    var r;
    try {
      r = await fetch("/api/connectors/meta-ads/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pending_id: fd.get("pending_id"),
          ad_account_id: fd.get("ad_account_id"),
        }),
      });
    } catch (err) {
      document.getElementById("err").textContent = "Network error: " + err.message;
      return;
    }
    var body;
    try { body = await r.json(); } catch (_) { body = { error: { message: r.statusText } }; }
    if (r.ok) {
      // The connection itself succeeded, but if the expiry write did NOT, say
      // so instead of redirecting as if everything landed. Silently redirecting
      // on { ok: true, expiry_recorded: false } recreates the exact NULL-expiry
      // shape this whole PR exists to kill — the token would die unannounced.
      // The auto-pick branch already fails visibly here; this is its parity.
      if (body && body.expiry_recorded === false) {
        document.getElementById("notice").textContent =
          "Meta Ads is connected and usable, but we could not record when the token expires, " +
          "so you may not get an early warning before it lapses. The daily health check " +
          "repairs this automatically within 24 hours — no action needed unless it persists.";
        document.getElementById("notice").hidden = false;
        document.getElementById("continue").href = target;
        document.getElementById("continue-wrap").hidden = false;
        e.target.querySelector("button[type=submit]").disabled = true;
        return;
      }
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.location.href = target;
          window.close();
          return;
        }
      } catch (e2) { /* cross-origin */ }
      window.location.href = target;
      return;
    }
    var msg = (body && body.error && body.error.message) || ("HTTP " + r.status);
    document.getElementById("err").textContent = "Connection failed: " + msg;
  });
})();
</script>`,
  );
}
