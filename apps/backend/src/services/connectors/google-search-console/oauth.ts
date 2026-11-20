import { ExpectedToolError } from "../../tools/types";
import { googleApiRequest, googleApiErrorText, type GoogleApiAuth } from "@/services/connectors/google-api-request";
import {
  googleSearchConsoleClientId,
  googleSearchConsoleClientSecret,
  GOOGLE_SEARCH_CONSOLE_SCOPE,
} from "../../tools/google-search-console/keys";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GSC_API = "https://searchconsole.googleapis.com/webmasters/v3";

export type GoogleSearchConsoleOAuthCreds = {
  client_id: string;
  client_secret: string;
  redirect_uri: string;
};

export function googleSearchConsoleOAuthCreds(): GoogleSearchConsoleOAuthCreds {
  const client_id = googleSearchConsoleClientId();
  const client_secret = googleSearchConsoleClientSecret();
  const backend_url = process.env.BACKEND_PUBLIC_URL;
  if (!client_id || !client_secret || !backend_url) {
    throw new Error(
      "google_search_console_misconfigured: set GOOGLE_SEARCH_CONSOLE_CLIENT_ID/SECRET " +
        "(or reuse GOOGLE_ADS_CLIENT_ID/SECRET) and BACKEND_PUBLIC_URL. The " +
        "OAuth client must list /api/connectors/google-search-console/callback as an " +
        "authorized redirect URI and request the webmasters.readonly scope.",
    );
  }
  return {
    client_id,
    client_secret,
    redirect_uri: `${backend_url.replace(/\/$/, "")}/api/connectors/google-search-console/callback`,
  };
}

export function googleSearchConsoleOAuthStartUrl(state: string): string {
  const creds = googleSearchConsoleOAuthCreds();
  const sp = new URLSearchParams({
    client_id: creds.client_id,
    redirect_uri: creds.redirect_uri,
    response_type: "code",
    scope: GOOGLE_SEARCH_CONSOLE_SCOPE,
    access_type: "offline",
    prompt: "select_account consent",
    include_granted_scopes: "true",
    state,
  });
  return `${AUTHORIZE_URL}?${sp.toString()}`;
}

export async function exchangeCode(
  code: string,
): Promise<{ refresh_token?: string; access_token: string; expires_in: number }> {
  const creds = googleSearchConsoleOAuthCreds();
  const body = new URLSearchParams({
    code,
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    redirect_uri: creds.redirect_uri,
    grant_type: "authorization_code",
  });
  let r: Response;
  try {
    r = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new ExpectedToolError("google_oauth_timeout", "Google token endpoint did not respond within 10s");
    }
    throw e;
  }
  if (!r.ok) {
    throw new ExpectedToolError(
      "google_oauth_exchange_failed",
      `Google token exchange returned ${r.status}: ${(await r.text()).slice(0, 300)}`,
    );
  }
  return (await r.json()) as { refresh_token?: string; access_token: string; expires_in: number };
}

export type GscSiteSummary = { site_url: string; permission_level: string };

export async function listAccessibleSites(accessTokenOrAuth: string | GoogleApiAuth): Promise<GscSiteSummary[]> {
  const auth: GoogleApiAuth = typeof accessTokenOrAuth === "string" ? { kind: "native", access_token: accessTokenOrAuth } : accessTokenOrAuth;
  let r;
  try {
    r = await googleApiRequest(auth, { method: "GET", url: `${GSC_API}/sites`, timeoutMs: 10_000 });
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new ExpectedToolError("google_search_console_api_timeout", "Search Console API did not respond within 10s");
    }
    throw e;
  }
  if (!r.ok) {
    throw new ExpectedToolError(
      "google_search_console_list_sites_failed",
      `sites.list returned ${r.status}: ${googleApiErrorText(r)}`,
    );
  }
  const json = r.json as unknown as {
    siteEntry?: Array<{ siteUrl?: string; permissionLevel?: string }>;
  };
  return (json.siteEntry ?? [])
    .filter((s) => s.siteUrl && s.permissionLevel && s.permissionLevel !== "siteUnverifiedUser")
    .map((s) => ({ site_url: s.siteUrl as string, permission_level: s.permissionLevel as string }))
    .sort((a, b) => a.site_url.localeCompare(b.site_url));
}
