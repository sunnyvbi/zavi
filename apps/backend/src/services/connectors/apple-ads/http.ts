
import { ExpectedToolError } from "@/services/tools/types";
import { APPLE_ADS_API_BASE, APPLE_ADS_SCOPE, APPLE_ADS_TOKEN_URL } from "./constants";
import { createAppleClientSecret } from "./jwt";
import { assertNoLabRefresh } from "@/services/connectors/core/lab-mode";

export type AppleCreds = {
  clientId: string;
  teamId: string;
  keyId: string;
  privateKeyPem: string;
  refreshToken?: string;
};

export type AppleEnvelope<T> = {
  result?: T;
  pagination?: { offset?: number; pageSize?: number; totalCount?: number } | null;
  error?: { code?: string; message?: string } | null;
};

const cache = new Map<string, { token: string; expiresAt: number }>();

export async function appleAccessToken(creds: AppleCreds, cacheKey: string): Promise<string> {
  const hit = cacheKey ? cache.get(cacheKey) : undefined;
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit.token;

  if (creds.refreshToken) assertNoLabRefresh("apple_ads");
  const clientSecret = createAppleClientSecret(creds);
  const body = new URLSearchParams(
    creds.refreshToken
      ? { grant_type: "refresh_token", client_id: creds.clientId, client_secret: clientSecret, refresh_token: creds.refreshToken }
      : { grant_type: "client_credentials", client_id: creds.clientId, client_secret: clientSecret, scope: APPLE_ADS_SCOPE },
  );
  const resp = await fetch(APPLE_ADS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) {
    throw new ExpectedToolError(
      "apple_ads_auth_failed",
      `Apple Ads token HTTP ${resp.status}. Check the client id, team id, key id, uploaded public key and ad-account access.`,
    );
  }
  const json = (await resp.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new ExpectedToolError("apple_ads_auth_failed", "Apple Ads token response missing access_token.");
  const ttl = typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 3600;
  if (cacheKey) cache.set(cacheKey, { token: json.access_token, expiresAt: Date.now() + ttl * 1000 });
  return json.access_token;
}

export async function appleAdsRequest<T>(
  accessToken: string,
  method: "GET" | "POST",
  path: string,
  opts: { adAccountId?: string; body?: unknown } = {},
): Promise<AppleEnvelope<T>> {
  if (!/^[a-z-]+(?:\/[a-zA-Z0-9-]+)*$/.test(path)) {
    throw new ExpectedToolError("apple_ads_bad_path", "apple_ads: invalid API path");
  }
  const resp = await fetch(`${APPLE_ADS_API_BASE}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      ...(opts.adAccountId ? { "X-AP-Context": `adAccountId=${opts.adAccountId}` } : {}),
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const raw = await resp.text();
  if (!resp.ok) {
    let code: string | undefined;
    try {
      code = (JSON.parse(raw) as AppleEnvelope<unknown>).error?.code;
    } catch {
    }
    throw new ExpectedToolError(
      resp.status === 401 || resp.status === 403 ? "apple_ads_forbidden" : "apple_ads_http_error",
      `Apple Ads API HTTP ${resp.status}${code ? ` (${code})` : ""}.${
        resp.status === 401 ? " Token or ad-account access problem — check credentials and account roles." : ""
      }`,
    );
  }
  try {
    return (raw ? JSON.parse(raw) : { result: undefined }) as AppleEnvelope<T>;
  } catch {
    throw new ExpectedToolError("apple_ads_bad_response", "Apple Ads API returned non-JSON.");
  }
}
