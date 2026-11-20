
import type {
  ConnectorIdentity,
  ConnectorExchangeResult,
  ConnectorOAuth,
  ConnectorRefreshResult,
} from "../core/types";
import { getSecret } from "@/services/secrets/vault";
import {
  REDDIT_ACCESS_TOKEN_TTL_SEC,
  REDDIT_SOCIAL_ACCESS_TOKEN_KEY,
  REDDIT_SOCIAL_REFRESH_TOKEN_KEY,
  REDDIT_SOCIAL_SLUG,
  REDDIT_SOCIAL_USERNAME_KEY,
  redditUserAgent,
} from "./constants";
import { assertNoLabRefresh } from "@/services/connectors/core/lab-mode";

const AUTHORIZE_URL = "https://www.reddit.com/api/v1/authorize";
const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const ME_URL = "https://oauth.reddit.com/api/v1/me";

const SCOPES = ["identity", "submit"];

export function redditSocialCreds(): { id: string; secret: string } {
  const id = process.env.REDDIT_SOCIAL_CLIENT_ID;
  const secret = process.env.REDDIT_SOCIAL_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error(
      "REDDIT_SOCIAL_CLIENT_ID and REDDIT_SOCIAL_CLIENT_SECRET must be set " +
        "(Reddit app of type 'web app' at reddit.com/prefs/apps).",
    );
  }
  return { id, secret };
}

export function redditSocialAuthorizeUrl(state: string, redirectUri: string): string {
  const { id } = redditSocialCreds();
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set("client_id", id);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("state", state);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("duration", "permanent");
  u.searchParams.set("scope", SCOPES.join(" "));
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
  const { id, secret } = redditSocialCreds();
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "User-Agent": redditUserAgent(),
      Accept: "application/json",
    },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Reddit token HTTP ${resp.status}: ${text.slice(0, 200)}`);
  const json = JSON.parse(text) as TokenResponse;
  if (json.error) throw new Error(`Reddit token error: ${json.error}`);
  return json;
}

async function fetchMe(accessToken: string): Promise<{ id: string; name: string }> {
  const resp = await fetch(ME_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": redditUserAgent(),
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`Reddit api/v1/me HTTP ${resp.status}`);
  const json = (await resp.json()) as { id?: string; name?: string };
  const name = json.name?.trim() ?? "";
  if (!name) throw new Error("Reddit api/v1/me missing name");
  return { id: json.id?.trim() || name, name };
}

export async function redditSocialExchangeCode(
  code: string,
  redirectUri: string,
): Promise<ConnectorExchangeResult> {
  const json = await postToken(
    new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
  );
  const access_token = json.access_token?.trim() ?? "";
  const refresh_token = json.refresh_token?.trim() ?? "";
  if (!access_token) throw new Error("Reddit token response missing access_token");
  if (!refresh_token) {
    throw new Error("Reddit token response missing refresh_token (duration=permanent not honoured?)");
  }
  const me = await fetchMe(access_token);
  return {
    secrets: {
      [REDDIT_SOCIAL_ACCESS_TOKEN_KEY]: access_token,
      [REDDIT_SOCIAL_REFRESH_TOKEN_KEY]: refresh_token,
      [REDDIT_SOCIAL_USERNAME_KEY]: me.name,
    },
    expiresInSec:
      typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : REDDIT_ACCESS_TOKEN_TTL_SEC,
    metadata: {
      team_id: me.id,
      team_name: `u/${me.name}`,
      scopes: (json.scope ?? SCOPES.join(" ")).split(/[\s,]+/).filter(Boolean),
    },
  };
}

export async function redditSocialRefreshToken(tenant_id: string): Promise<ConnectorRefreshResult> {
  assertNoLabRefresh("reddit_social");
  const current = await getSecret(tenant_id, REDDIT_SOCIAL_REFRESH_TOKEN_KEY);
  if (!current) throw new Error("reddit_social not connected (no refresh token)");
  const json = await postToken(new URLSearchParams({ grant_type: "refresh_token", refresh_token: current }));
  const access_token = json.access_token?.trim() ?? "";
  if (!access_token) throw new Error("Reddit refresh response missing access_token");
  return {
    secrets: {
      [REDDIT_SOCIAL_ACCESS_TOKEN_KEY]: access_token,
      [REDDIT_SOCIAL_REFRESH_TOKEN_KEY]: json.refresh_token?.trim() || current,
    },
    expiresInSec:
      typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : REDDIT_ACCESS_TOKEN_TTL_SEC,
  };
}

export async function redditSocialFetchIdentity(
  tenant_id: string,
): Promise<ConnectorIdentity | null> {
  const token = await getSecret(tenant_id, REDDIT_SOCIAL_ACCESS_TOKEN_KEY);
  if (!token) return null;
  const me = await fetchMe(token);
  return { team_id: me.id, team_name: `u/${me.name}` };
}

export const redditSocialConnector: ConnectorOAuth = {
  slug: REDDIT_SOCIAL_SLUG,
  serverId: REDDIT_SOCIAL_SLUG,
  scopes: SCOPES,
  authorizeUrl: redditSocialAuthorizeUrl,
  exchangeCode: redditSocialExchangeCode,
  refreshToken: redditSocialRefreshToken,
  fetchIdentity: redditSocialFetchIdentity,
};
