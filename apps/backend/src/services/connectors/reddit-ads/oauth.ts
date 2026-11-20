
import type {
  ConnectorExchangeResult,
  ConnectorOAuth,
  ConnectorRefreshResult,
} from "../core/types";
import { getSecret } from "@/services/secrets/vault";
import {
  REDDIT_ADS_ACCESS_TOKEN_KEY,
  REDDIT_ADS_ACCESS_TOKEN_TTL_SEC,
  REDDIT_ADS_REFRESH_TOKEN_KEY,
  REDDIT_ADS_SCOPES,
  REDDIT_ADS_SLUG,
  REDDIT_ADS_USERNAME_KEY,
  redditAdsCreds,
  redditAdsUserAgent,
} from "./constants";
import { listRedditBusinesses } from "./http";
import { assertNoLabRefresh } from "@/services/connectors/core/lab-mode";

const AUTHORIZE_URL = "https://www.reddit.com/api/v1/authorize";
const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";

export function redditAdsAuthorizeUrl(state: string, redirectUri: string): string {
  const { id } = redditAdsCreds();
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set("client_id", id);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("state", state);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("duration", "permanent");
  u.searchParams.set("scope", REDDIT_ADS_SCOPES.join(" "));
  return u.toString();
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
};

async function postToken(body: URLSearchParams): Promise<TokenResponse> {
  const { id, secret } = redditAdsCreds();
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "User-Agent": redditAdsUserAgent(),
      Accept: "application/json",
    },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Reddit Ads token HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  const json = JSON.parse(text) as TokenResponse;
  if (json.error) throw new Error(`Reddit Ads token error: ${json.error}`);
  return json;
}

export async function redditAdsExchangeCode(
  code: string,
  redirectUri: string,
): Promise<ConnectorExchangeResult> {
  const json = await postToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  );
  const access_token = json.access_token?.trim() ?? "";
  const refresh_token = json.refresh_token?.trim() ?? "";
  if (!access_token) throw new Error("Reddit Ads token response missing access_token");
  if (!refresh_token) {
    throw new Error(
      "Reddit Ads token response missing refresh_token (duration=permanent not honoured?)",
    );
  }

  const businesses = await listRedditBusinesses(access_token);
  const first = businesses[0];

  return {
    secrets: {
      [REDDIT_ADS_ACCESS_TOKEN_KEY]: access_token,
      [REDDIT_ADS_REFRESH_TOKEN_KEY]: refresh_token,
      [REDDIT_ADS_USERNAME_KEY]: first?.name ?? "",
    },
    expiresInSec:
      typeof json.expires_in === "number" && json.expires_in > 0
        ? json.expires_in
        : REDDIT_ADS_ACCESS_TOKEN_TTL_SEC,
    metadata: {
      team_id: first?.id ?? "no_business",
      team_name: first?.name ?? "Reddit Ads (no business found)",
      scopes: (json.scope ?? REDDIT_ADS_SCOPES.join(" ")).split(/[\s,]+/).filter(Boolean),
    },
  };
}

export async function redditAdsRefreshToken(
  tenant_id: string,
): Promise<ConnectorRefreshResult> {
  assertNoLabRefresh("reddit_ads");
  const current = await getSecret(tenant_id, REDDIT_ADS_REFRESH_TOKEN_KEY);
  if (!current) throw new Error("reddit_ads not connected (no refresh token)");
  const json = await postToken(
    new URLSearchParams({ grant_type: "refresh_token", refresh_token: current }),
  );
  const access_token = json.access_token?.trim() ?? "";
  if (!access_token) throw new Error("Reddit Ads refresh response missing access_token");
  return {
    secrets: {
      [REDDIT_ADS_ACCESS_TOKEN_KEY]: access_token,
      [REDDIT_ADS_REFRESH_TOKEN_KEY]: json.refresh_token?.trim() || current,
    },
    expiresInSec:
      typeof json.expires_in === "number" && json.expires_in > 0
        ? json.expires_in
        : REDDIT_ADS_ACCESS_TOKEN_TTL_SEC,
  };
}

export const redditAdsConnector: ConnectorOAuth = {
  slug: REDDIT_ADS_SLUG,
  serverId: REDDIT_ADS_SLUG,
  scopes: [...REDDIT_ADS_SCOPES],
  authorizeUrl: redditAdsAuthorizeUrl,
  exchangeCode: redditAdsExchangeCode,
  refreshToken: redditAdsRefreshToken,
};
