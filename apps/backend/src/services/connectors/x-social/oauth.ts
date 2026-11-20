
import { createHash, createHmac } from "node:crypto";
import type {
  ConnectorIdentity,
  ConnectorExchangeResult,
  ConnectorOAuth,
  ConnectorRefreshResult,
} from "../core/types";
import { getSecret } from "@/services/secrets/vault";
import {
  X_ACCESS_TOKEN_TTL_SEC,
  X_SOCIAL_ACCESS_TOKEN_KEY,
  X_SOCIAL_REFRESH_TOKEN_KEY,
  X_SOCIAL_SLUG,
  X_SOCIAL_USER_ID_KEY,
} from "./constants";
import { assertNoLabRefresh } from "@/services/connectors/core/lab-mode";

const AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const TOKEN_URL = "https://api.x.com/2/oauth2/token";
const ME_URL = "https://api.x.com/2/users/me";
const REVOKE_URL = "https://api.x.com/2/oauth2/revoke";

const SCOPES = ["tweet.read", "tweet.write", "users.read", "offline.access", "media.write"];

export function xSocialCreds(): { id: string; secret: string } {
  const id = process.env.X_SOCIAL_CLIENT_ID;
  const secret = process.env.X_SOCIAL_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error(
      "X_SOCIAL_CLIENT_ID and X_SOCIAL_CLIENT_SECRET must be set " +
        "(X Developer app with OAuth 2.0 user authentication + tweet.write).",
    );
  }
  return { id, secret };
}

function stateSecret(): string {
  const s = process.env.OAUTH_STATE_SECRET ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!s) throw new Error("OAUTH_STATE_SECRET not configured (PKCE verifier derivation)");
  return s;
}

export function pkceVerifierFor(rawState: string): string {
  return createHmac("sha256", stateSecret()).update(`x_social:${rawState}`).digest("base64url");
}

export function pkceChallengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function xSocialAuthorizeUrl(state: string, redirectUri: string): string {
  const { id } = xSocialCreds();
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", id);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("scope", SCOPES.join(" "));
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", pkceChallengeFor(pkceVerifierFor(state)));
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
};

async function postToken(body: URLSearchParams): Promise<TokenResponse> {
  const { id, secret } = xSocialCreds();
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      Accept: "application/json",
    },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`X token HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  return (await resp.json()) as TokenResponse;
}

async function fetchMe(accessToken: string): Promise<{ id: string; username: string }> {
  const resp = await fetch(ME_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`X users/me HTTP ${resp.status}: ${detail.slice(0, 300)}`);
  }
  const json = (await resp.json()) as { data?: { id?: string; username?: string } };
  const id = json.data?.id?.trim() ?? "";
  if (!id) throw new Error("X users/me missing id");
  return { id, username: json.data?.username?.trim() || id };
}

export async function xSocialExchangeCode(
  code: string,
  redirectUri: string,
  rawState?: string,
): Promise<ConnectorExchangeResult> {
  if (!rawState) {
    throw new Error("x_social exchangeCode requires the raw OAuth state (PKCE verifier derivation)");
  }
  const { id } = xSocialCreds();
  const json = await postToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: id,
      code_verifier: pkceVerifierFor(rawState),
    }),
  );
  const access_token = json.access_token?.trim() ?? "";
  const refresh_token = json.refresh_token?.trim() ?? "";
  if (!access_token) throw new Error("X token response missing access_token");
  if (!refresh_token) throw new Error("X token response missing refresh_token (offline.access not granted?)");
  const me = await fetchMe(access_token);
  return {
    secrets: {
      [X_SOCIAL_ACCESS_TOKEN_KEY]: access_token,
      [X_SOCIAL_REFRESH_TOKEN_KEY]: refresh_token,
      [X_SOCIAL_USER_ID_KEY]: me.id,
    },
    expiresInSec:
      typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : X_ACCESS_TOKEN_TTL_SEC,
    metadata: {
      team_id: me.id,
      team_name: `@${me.username}`,
      scopes: (json.scope ?? SCOPES.join(" ")).split(/\s+/).filter(Boolean),
    },
  };
}

export async function xSocialRefreshToken(tenant_id: string): Promise<ConnectorRefreshResult> {
  assertNoLabRefresh("x_social");
  const current = await getSecret(tenant_id, X_SOCIAL_REFRESH_TOKEN_KEY);
  if (!current) throw new Error("x_social not connected (no refresh token)");
  const { id } = xSocialCreds();
  const json = await postToken(
    new URLSearchParams({ grant_type: "refresh_token", refresh_token: current, client_id: id }),
  );
  const access_token = json.access_token?.trim() ?? "";
  if (!access_token) throw new Error("X refresh response missing access_token");
  return {
    secrets: {
      [X_SOCIAL_ACCESS_TOKEN_KEY]: access_token,
      [X_SOCIAL_REFRESH_TOKEN_KEY]: json.refresh_token?.trim() || current,
    },
    expiresInSec:
      typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : X_ACCESS_TOKEN_TTL_SEC,
  };
}

export async function xSocialFetchIdentity(
  tenant_id: string,
): Promise<ConnectorIdentity | null> {
  const token = await getSecret(tenant_id, X_SOCIAL_ACCESS_TOKEN_KEY);
  if (!token) return null;
  const me = await fetchMe(token);
  return { team_id: me.id, team_name: `@${me.username}` };
}

export async function xSocialRevokeToken(accessToken: string): Promise<void> {
  const { id, secret } = xSocialCreds();
  const resp = await fetch(REVOKE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
    },
    body: new URLSearchParams({ token: accessToken, token_type_hint: "access_token" }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`X revoke HTTP ${resp.status}`);
}

export const xSocialConnector: ConnectorOAuth = {
  slug: X_SOCIAL_SLUG,
  serverId: X_SOCIAL_SLUG,
  scopes: SCOPES,
  authorizeUrl: xSocialAuthorizeUrl,
  exchangeCode: xSocialExchangeCode,
  refreshToken: xSocialRefreshToken,
  fetchIdentity: xSocialFetchIdentity,
  revokeToken: xSocialRevokeToken,
};
