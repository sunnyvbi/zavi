
import { getSecret } from "@/services/secrets/vault";
import { hasComposioSignIn, resolveOwnedComposioAccount } from "@/services/connectors/composio/account";
import { googleApiRequest, googleApiErrorText, type GoogleApiAuth } from "@/services/connectors/google-api-request";
import { ExpectedToolError } from "@/services/tools/types";
import {
  GOOGLE_ANALYTICS_VAULT_KEYS,
  googleAnalyticsClientId,
  googleAnalyticsClientSecret,
} from "./keys";

export const GA_DATA_API = "https://analyticsdata.googleapis.com/v1beta";

type AccessTokenCache = { access_token: string; expires_at_ms: number };
const ACCESS_TOKEN_CACHE = new Map<string, AccessTokenCache>();

export type GoogleAnalyticsCreds = {
  property_id: string;
  auth: GoogleApiAuth;
};

export async function googleAnalyticsCreds(tenant_id: string): Promise<GoogleAnalyticsCreds> {
  const clientId = googleAnalyticsClientId();
  const clientSecret = googleAnalyticsClientSecret();
  const refreshToken = await getSecret(tenant_id, GOOGLE_ANALYTICS_VAULT_KEYS.refresh_token);
  const propertyId = await getSecret(tenant_id, GOOGLE_ANALYTICS_VAULT_KEYS.property_id);

  if (!refreshToken && propertyId) {
    let account = null;
    try {
      account = await resolveOwnedComposioAccount(tenant_id, "google_analytics");
    } catch {
      throw new ExpectedToolError(
        "google_analytics_unavailable",
        "Google Analytics could not be checked right now (a temporary error reading the connection). Try again in a minute; the connection itself is fine.",
        { next_step: "retry", unblockers: [] },
      );
    }
    if (!account) {
      throw new ExpectedToolError(
        "google_analytics_not_connected",
        "Google Analytics is not connected for this workspace. Operator must complete the OAuth flow at /connectors → Google Analytics. Until connected, GA4 attribution is unavailable.",
        { next_step: "operator_action", unblockers: ["Complete OAuth at /connectors → Google Analytics"] },
      );
    }
    return { property_id: propertyId.replace(/\D/g, ""), auth: { kind: "composio", account } };
  }

  if (!refreshToken && !propertyId && (await hasComposioSignIn(tenant_id, "google_analytics").catch(() => false))) {
    throw new ExpectedToolError(
      "google_analytics_not_connected",
      "Google sign-in worked, but no Google Analytics property is set up for this workspace. Connect again in Settings and pick one (or create a property in Google Analytics first).",
      { next_step: "operator_action", unblockers: ["Connect Google Analytics again in Settings and pick a property"] },
    );
  }

  if (!clientId || !clientSecret) {
    throw new ExpectedToolError(
      "google_analytics_not_configured",
      "Google Analytics is not configured on this Praxis deployment. The GOOGLE_ANALYTICS_CLIENT_ID / GOOGLE_ANALYTICS_CLIENT_SECRET env secrets (or the reused GOOGLE_ADS_* pair) are unset.",
      { next_step: "praxis_admin_action", unblockers: ["Set the GOOGLE_ANALYTICS_* (or GOOGLE_ADS_*) OAuth client env secrets in AWS Secrets Manager praxis-envprod-1"] },
    );
  }
  if (!refreshToken || !propertyId) {
    throw new ExpectedToolError(
      "google_analytics_not_connected",
      "Google Analytics is not connected for this workspace. Operator must complete the OAuth flow at /connectors → Google Analytics. Until connected, GA4 attribution is unavailable.",
      { next_step: "operator_action", unblockers: ["Complete OAuth at /connectors → Google Analytics"] },
    );
  }

  const accessToken = await getOrRefreshAccessToken(tenant_id, clientId, clientSecret, refreshToken);
  return { property_id: propertyId.replace(/\D/g, ""), auth: { kind: "native", access_token: accessToken } };
}

async function getOrRefreshAccessToken(
  tenant_id: string,
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<string> {
  const cached = ACCESS_TOKEN_CACHE.get(tenant_id);
  if (cached && cached.expires_at_ms > Date.now() + 60_000) {
    return cached.access_token;
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) {
    throw new ExpectedToolError(
      "google_analytics_oauth_refresh_failed",
      `Google OAuth refresh failed: ${r.status} ${(await r.text()).slice(0, 300)}`,
    );
  }
  const json = (await r.json()) as { access_token: string; expires_in?: number };
  const cache: AccessTokenCache = {
    access_token: json.access_token,
    expires_at_ms: Date.now() + (json.expires_in ?? 3000) * 1000,
  };
  ACCESS_TOKEN_CACHE.set(tenant_id, cache);
  return cache.access_token;
}

export type GaFilterExpression =
  | { andGroup: { expressions: GaFilterExpression[] } }
  | { orGroup: { expressions: GaFilterExpression[] } }
  | { notExpression: GaFilterExpression }
  | { filter: { fieldName: string; stringFilter?: { matchType: "EXACT"; value: string; caseSensitive?: boolean }; inListFilter?: { values: string[]; caseSensitive?: boolean } } };

export type GaRunReportBody = {
  dateRanges: Array<{ startDate: string; endDate: string }>;
  dimensions?: Array<{ name: string }>;
  metrics: Array<{ name: string }>;
  dimensionFilter?: GaFilterExpression;
  limit?: string;
  offset?: string;
  metricAggregations?: Array<"TOTAL" | "MAXIMUM" | "MINIMUM">;
};

export type GaRunReportResponse = {
  dimensionHeaders?: Array<{ name: string }>;
  metricHeaders?: Array<{ name: string; type?: string }>;
  rows?: Array<{
    dimensionValues?: Array<{ value?: string }>;
    metricValues?: Array<{ value?: string }>;
  }>;
  rowCount?: number;
  metadata?: { timeZone?: string; currencyCode?: string };
  totals?: Array<{
    dimensionValues?: Array<{ value?: string }>;
    metricValues?: Array<{ value?: string }>;
  }>;
};

export async function runReport(tenant_id: string, body: GaRunReportBody): Promise<GaRunReportResponse> {
  return runReportWith(await googleAnalyticsCreds(tenant_id), body);
}

export async function runReportWith(creds: GoogleAnalyticsCreds, body: GaRunReportBody, timeoutMs = 15_000): Promise<GaRunReportResponse> {
  let r;
  try {
    r = await googleApiRequest(creds.auth, {
      method: "POST",
      url: `${GA_DATA_API}/properties/${creds.property_id}:runReport`,
      body,
      timeoutMs,
    });
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new ExpectedToolError("google_analytics_api_timeout", `GA4 Data API did not respond within ${Math.round(timeoutMs / 1000)}s`);
    }
    throw e;
  }
  if (!r.ok) {
    throw new ExpectedToolError(
      "google_analytics_run_report_failed",
      `GA4 runReport returned ${r.status}: ${googleApiErrorText(r)}`,
    );
  }
  return r.json as GaRunReportResponse;
}
