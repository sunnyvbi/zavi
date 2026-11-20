
import { ExpectedToolError } from "../../tools/types";
import { googleApiRequest, googleApiErrorText, type GoogleApiAuth } from "@/services/connectors/google-api-request";
import {
  googleAnalyticsClientId,
  googleAnalyticsClientSecret,
  GOOGLE_ANALYTICS_SCOPE,
} from "../../tools/google-analytics/keys";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ADMIN_API = "https://analyticsadmin.googleapis.com/v1beta";

export type GoogleAnalyticsOAuthCreds = {
  client_id: string;
  client_secret: string;
  redirect_uri: string;
};

export function googleAnalyticsOAuthCreds(): GoogleAnalyticsOAuthCreds {
  const client_id = googleAnalyticsClientId();
  const client_secret = googleAnalyticsClientSecret();
  const backend_url = process.env.BACKEND_PUBLIC_URL;
  if (!client_id || !client_secret || !backend_url) {
    throw new Error(
      "google_analytics_misconfigured: set GOOGLE_ANALYTICS_CLIENT_ID/SECRET " +
        "(or reuse GOOGLE_ADS_CLIENT_ID/SECRET) and BACKEND_PUBLIC_URL. The " +
        "OAuth client must list /api/connectors/google-analytics/callback as an " +
        "authorized redirect URI and request the analytics.readonly scope.",
    );
  }
  return {
    client_id,
    client_secret,
    redirect_uri: `${backend_url.replace(/\/$/, "")}/api/connectors/google-analytics/callback`,
  };
}

export function googleAnalyticsOAuthStartUrl(state: string): string {
  const creds = googleAnalyticsOAuthCreds();
  const sp = new URLSearchParams({
    client_id: creds.client_id,
    redirect_uri: creds.redirect_uri,
    response_type: "code",
    scope: GOOGLE_ANALYTICS_SCOPE,
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
  const creds = googleAnalyticsOAuthCreds();
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

export type GaPropertySummary = { property_id: string; display_name: string };

export async function listAccessibleProperties(accessTokenOrAuth: string | GoogleApiAuth): Promise<GaPropertySummary[]> {
  const auth: GoogleApiAuth = typeof accessTokenOrAuth === "string" ? { kind: "native", access_token: accessTokenOrAuth } : accessTokenOrAuth;
  const out: GaPropertySummary[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 20; page++) {
    const url = new URL(`${ADMIN_API}/accountSummaries`);
    url.searchParams.set("pageSize", "200");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    let r;
    try {
      r = await googleApiRequest(auth, { method: "GET", url: url.toString(), timeoutMs: 10_000 });
    } catch (e) {
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
        throw new ExpectedToolError("google_analytics_api_timeout", "GA Admin API did not respond within 10s");
      }
      throw e;
    }
    if (!r.ok) {
      throw new ExpectedToolError(
        "google_analytics_list_properties_failed",
        `accountSummaries.list returned ${r.status}: ${googleApiErrorText(r)}`,
      );
    }
    const json = r.json as {
      accountSummaries?: Array<{
        displayName?: string;
        propertySummaries?: Array<{ property?: string; displayName?: string }>;
      }>;
      nextPageToken?: string;
    };
    for (const acct of json.accountSummaries ?? []) {
      for (const p of acct.propertySummaries ?? []) {
        const id = (p.property ?? "").replace(/^properties\//, "").replace(/\D/g, "");
        if (!id) continue;
        const acctName = acct.displayName ?? "Account";
        const propName = p.displayName ?? id;
        out.push({ property_id: id, display_name: `${acctName} › ${propName}` });
      }
    }
    if (!json.nextPageToken) break;
    pageToken = json.nextPageToken;
  }
  return out;
}
