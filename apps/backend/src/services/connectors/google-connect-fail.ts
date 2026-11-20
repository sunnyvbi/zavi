export type GoogleConnectSlug = "google_analytics" | "google_search_console";

export type GoogleConnectFailure =
  | "access_denied"
  | "blocked_by_admin"
  | "google_refused"
  | "missing_params"
  | "invalid_state"
  | "state_consume_failed"
  | "reconnect_required"
  | "google_api_error"
  | "google_scope_missing"
  | "no_properties"
  | "no_sites"
  | "persist_failed"
  | "stash_failed";

function webOrigin(): string {
  return (process.env.WEB_ORIGIN || "http://localhost:3000").split(",")[0].trim();
}

export function googleConnectBackTarget(slug?: GoogleConnectSlug, code?: GoogleConnectFailure): string {
  const base = `${webOrigin()}/workspace?tab=settings`;
  if (!slug) return base;
  const qs = new URLSearchParams({ composio_error: slug });
  if (code) qs.set("code", code);
  return `${base}&${qs.toString()}`;
}

const NAME: Record<GoogleConnectSlug, string> = {
  google_analytics: "Google Analytics",
  google_search_console: "Google Search Console",
};

const SCOPE_BOX: Record<GoogleConnectSlug, string> = {
  google_analytics: "Google Analytics",
  google_search_console: "Search Console",
};

const EXPIRED = "The sign-in took too long or was already used. Try again.";

const REASON: Partial<Record<GoogleConnectFailure, string>> = {
  access_denied: "Google access wasn’t allowed. Try again and click Allow.",
  blocked_by_admin:
    "Your Google Workspace admin doesn’t allow this app. Ask your admin to allow Zavi, or sign in with a different Google account.",
  google_refused: "Google couldn’t start the sign-in. Try again, and contact support if it keeps happening.",
  missing_params: EXPIRED,
  invalid_state: EXPIRED,
  reconnect_required:
    "Google needs a fresh sign-in. Remove Zavi from your Google account’s third-party access, then try again.",
  google_api_error: "Google didn’t answer as expected. Try again in a minute.",
  no_properties:
    "This Google account can’t see any Google Analytics property. Sign in with the account that has your site’s analytics, or ask its owner to add you, then try again.",
  no_sites:
    "This Google account has no verified site in Search Console. Sign in with the account that owns your site, or verify your site in Search Console, then try again.",
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function googleOAuthErrorFailure(error: string): GoogleConnectFailure {
  if (error === "access_denied") return "access_denied";
  if (error === "admin_policy_enforced" || error === "org_internal") return "blocked_by_admin";
  return "google_refused";
}

export function isGoogleScopeInsufficient(message: string): boolean {
  return /returned 403\b/.test(message) && /insufficient authentication scopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(message);
}

export function googleConnectFailReason(code: GoogleConnectFailure, slug?: GoogleConnectSlug): string {
  if (code === "google_scope_missing" && slug) {
    return `Google didn’t give Zavi access to ${SCOPE_BOX[slug]}. Reconnect and tick the ${SCOPE_BOX[slug]} box.`;
  }
  return REASON[code] ?? "Something went wrong on our side. Try again, and contact support if it keeps happening.";
}

export function renderGoogleConnectFailHtml(slug: GoogleConnectSlug, code: GoogleConnectFailure): string {
  const target = googleConnectBackTarget(slug, code);
  const title = escapeHtml(`Couldn’t connect ${NAME[slug]}`);
  const reason = escapeHtml(googleConnectFailReason(code, slug));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;max-width:520px;margin:48px auto;padding:0 24px;color:#0f172a}h1{font-size:20px;font-weight:600;margin:0 0 12px}p{line-height:1.55;color:#334155;font-size:14.5px;margin:0 0 20px}a{display:inline-block;background:#0f172a;color:#fff;text-decoration:none;font-size:14px;font-weight:500;padding:10px 16px;border-radius:8px}</style></head><body><h1>${title}</h1><p>${reason}</p><a id="back" href="${escapeHtml(target)}">Back to Zavi</a><script>document.getElementById("back").addEventListener("click",function(e){try{if(window.opener&&!window.opener.closed){e.preventDefault();window.opener.location.href=${JSON.stringify(target)};window.opener.focus();window.close();}}catch(_){}});</script></body></html>`;
}
