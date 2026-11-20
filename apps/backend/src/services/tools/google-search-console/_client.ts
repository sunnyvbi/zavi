import { getSecret } from "@/services/secrets/vault";
import { hasComposioSignIn, resolveOwnedComposioAccount } from "@/services/connectors/composio/account";
import { googleApiRequest, googleApiErrorText, type GoogleApiAuth } from "@/services/connectors/google-api-request";
import { ExpectedToolError } from "@/services/tools/types";
import {
  GOOGLE_SEARCH_CONSOLE_VAULT_KEYS,
  googleSearchConsoleClientId,
  googleSearchConsoleClientSecret,
} from "./keys";

export const GSC_API = "https://searchconsole.googleapis.com/webmasters/v3";
export const GSC_API_V1 = "https://searchconsole.googleapis.com/v1";

type AccessTokenCache = { access_token: string; expires_at_ms: number };
const ACCESS_TOKEN_CACHE = new Map<string, AccessTokenCache>();

export type GoogleSearchConsoleCreds = {
  site_url: string;
  auth: GoogleApiAuth;
};

export async function googleSearchConsoleCreds(tenant_id: string): Promise<GoogleSearchConsoleCreds> {
  const clientId = googleSearchConsoleClientId();
  const clientSecret = googleSearchConsoleClientSecret();
  const refreshToken = await getSecret(tenant_id, GOOGLE_SEARCH_CONSOLE_VAULT_KEYS.refresh_token);
  const siteUrl = await getSecret(tenant_id, GOOGLE_SEARCH_CONSOLE_VAULT_KEYS.site_url);

  if (!refreshToken && siteUrl) {
    let account = null;
    try {
      account = await resolveOwnedComposioAccount(tenant_id, "google_search_console");
    } catch {
      throw new ExpectedToolError(
        "google_search_console_unavailable",
        "Google Search Console could not be checked right now (a temporary error reading the connection). Try again in a minute; the connection itself is fine.",
        { next_step: "retry", unblockers: [] },
      );
    }
    if (!account) {
      throw new ExpectedToolError(
        "google_search_console_not_connected",
        "Google Search Console is not connected for this workspace. Operator must complete the OAuth flow at Settings → Google Search Console. Until connected, search performance data is unavailable.",
        { next_step: "operator_action", unblockers: ["Complete OAuth at Settings → Google Search Console"] },
      );
    }
    return { site_url: siteUrl, auth: { kind: "composio", account } };
  }

  if (!refreshToken && !siteUrl && (await hasComposioSignIn(tenant_id, "google_search_console").catch(() => false))) {
    throw new ExpectedToolError(
      "google_search_console_not_connected",
      "Google sign-in worked, but no Search Console site is set up for this workspace. Connect again in Settings and pick one (or add your site in Google Search Console first).",
      { next_step: "operator_action", unblockers: ["Connect Google Search Console again in Settings and pick a site"] },
    );
  }

  if (!clientId || !clientSecret) {
    throw new ExpectedToolError(
      "google_search_console_not_configured",
      "Google Search Console is not configured on this Praxis deployment. The GOOGLE_SEARCH_CONSOLE_CLIENT_ID / GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET env secrets (or the reused GOOGLE_ADS_* pair) are unset.",
      { next_step: "praxis_admin_action", unblockers: ["Set the GOOGLE_SEARCH_CONSOLE_* (or GOOGLE_ADS_*) OAuth client env secrets in AWS Secrets Manager praxis-envprod-1"] },
    );
  }
  if (!refreshToken || !siteUrl) {
    throw new ExpectedToolError(
      "google_search_console_not_connected",
      "Google Search Console is not connected for this workspace. Operator must complete the OAuth flow at Settings → Google Search Console. Until connected, search performance data is unavailable.",
      { next_step: "operator_action", unblockers: ["Complete OAuth at Settings → Google Search Console"] },
    );
  }

  const accessToken = await getOrRefreshAccessToken(tenant_id, clientId, clientSecret, refreshToken);
  return { site_url: siteUrl, auth: { kind: "native", access_token: accessToken } };
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
      "google_search_console_oauth_refresh_failed",
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

export type GscDimensionFilter = {
  dimension: string;
  operator: "equals" | "notEquals" | "contains" | "notContains" | "includingRegex" | "excludingRegex";
  expression: string;
};

export type GscSearchAnalyticsBody = {
  startDate: string;
  endDate: string;
  dimensions?: string[];
  rowLimit?: number;
  startRow?: number;
  type?: string;
  dimensionFilterGroups?: Array<{ groupType?: "and"; filters: GscDimensionFilter[] }>;
};

export type GscSearchAnalyticsResponse = {
  rows?: Array<{
    keys?: string[];
    clicks?: number;
    impressions?: number;
    ctr?: number;
    position?: number;
  }>;
  responseAggregationType?: string;
};

export async function searchAnalyticsQuery(
  tenant_id: string,
  body: GscSearchAnalyticsBody,
  presolved?: GoogleSearchConsoleCreds,
): Promise<GscSearchAnalyticsResponse> {
  const creds = presolved ?? (await googleSearchConsoleCreds(tenant_id));
  const r = await gscRequest(creds.auth, "POST", `${GSC_API}/sites/${encodeURIComponent(creds.site_url)}/searchAnalytics/query`, body);
  if (!r.ok) {
    throw new ExpectedToolError(
      "google_search_console_query_failed",
      `Search Console searchAnalytics.query returned ${r.status}: ${googleApiErrorText(r)}`,
    );
  }
  return r.json as unknown as GscSearchAnalyticsResponse;
}

export type GscInspectionResult = {
  inspectionResultLink?: string;
  indexStatusResult?: {
    verdict?: string;
    coverageState?: string;
    robotsTxtState?: string;
    indexingState?: string;
    lastCrawlTime?: string;
    pageFetchState?: string;
    googleCanonical?: string;
    userCanonical?: string;
    sitemap?: string[];
    referringUrls?: string[];
    crawledAs?: string;
  };
  mobileUsabilityResult?: { verdict?: string; issues?: Array<{ issueType?: string; severity?: string; message?: string }> };
  richResultsResult?: {
    verdict?: string;
    detectedItems?: Array<{
      richResultType?: string;
      items?: Array<{ name?: string; issues?: Array<{ issueMessage?: string; severity?: string }> }>;
    }>;
  };
};

export async function urlInspect(
  tenant_id: string,
  inspectionUrl: string,
  languageCode: string,
): Promise<{ site_url: string; result: GscInspectionResult }> {
  const creds = await googleSearchConsoleCreds(tenant_id);
  const r = await gscRequest(creds.auth, "POST", `${GSC_API_V1}/urlInspection/index:inspect`, { inspectionUrl, siteUrl: creds.site_url, languageCode });
  if (!r.ok) {
    const text = googleApiErrorText(r);
    if (r.status === 403) {
      throw new ExpectedToolError(
        "google_search_console_url_not_in_property",
        `Search Console refused to inspect ${inspectionUrl}: it is not under the connected property ${creds.site_url} (or the account lacks permission). ${text}`,
        { next_step: "operator_action", unblockers: [`Inspect a URL under ${creds.site_url}, or connect the property that owns this URL`] },
      );
    }
    if (r.status === 429) {
      throw new ExpectedToolError(
        "google_search_console_inspection_quota_exceeded",
        `Search Console URL Inspection quota exhausted (2,000/day, 600/min per property): ${text}`,
      );
    }
    throw new ExpectedToolError(
      "google_search_console_inspect_failed",
      `urlInspection.index.inspect returned ${r.status}: ${text}`,
    );
  }
  const json = r.json as { inspectionResult?: GscInspectionResult };
  return { site_url: creds.site_url, result: json.inspectionResult ?? {} };
}

export type GscSitemapEntry = {
  path?: string;
  lastSubmitted?: string;
  lastDownloaded?: string;
  isPending?: boolean;
  isSitemapsIndex?: boolean;
  type?: string;
  warnings?: string | number;
  errors?: string | number;
  contents?: Array<{ type?: string; submitted?: string | number; indexed?: string | number }>;
};

export async function listSitemaps(tenant_id: string): Promise<{ site_url: string; sitemaps: GscSitemapEntry[] }> {
  const creds = await googleSearchConsoleCreds(tenant_id);
  const r = await gscRequest(creds.auth, "GET", `${GSC_API}/sites/${encodeURIComponent(creds.site_url)}/sitemaps`);
  if (!r.ok) {
    throw new ExpectedToolError(
      "google_search_console_sitemaps_failed",
      `sitemaps.list returned ${r.status}: ${googleApiErrorText(r)}`,
    );
  }
  const json = r.json as { sitemap?: GscSitemapEntry[] };
  return { site_url: creds.site_url, sitemaps: json.sitemap ?? [] };
}

async function gscRequest(auth: GoogleApiAuth, method: "GET" | "POST", url: string, body?: unknown) {
  try {
    return await googleApiRequest(auth, { method, url, ...(body !== undefined ? { body } : {}), timeoutMs: 15_000 });
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new ExpectedToolError("google_search_console_api_timeout", "Search Console API did not respond within 15s");
    }
    throw e;
  }
}
