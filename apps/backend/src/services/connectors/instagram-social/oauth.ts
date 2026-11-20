
import type {
  ConnectorIdentity,
  ConnectorExchangeResult,
  ConnectorOAuth,
  ConnectorRefreshResult,
} from "../core/types";
import { getSecret } from "@/services/secrets/vault";
import {
  INSTAGRAM_GRAPH_URL,
  INSTAGRAM_GRAPH_VERSION,
  INSTAGRAM_LONG_LIVED_TTL_SEC,
  INSTAGRAM_SOCIAL_ACCESS_TOKEN_KEY,
  INSTAGRAM_SOCIAL_SLUG,
  INSTAGRAM_SOCIAL_USERNAME_KEY,
  INSTAGRAM_SOCIAL_USER_ID_KEY,
} from "./constants";

const AUTHORIZE_URL = "https://www.instagram.com/oauth/authorize";
const TOKEN_URL = "https://api.instagram.com/oauth/access_token";

const SCOPES = ["instagram_business_basic", "instagram_business_content_publish"];

export function instagramSocialCreds(): { id: string; secret: string } {
  const id = process.env.INSTAGRAM_SOCIAL_CLIENT_ID;
  const secret = process.env.INSTAGRAM_SOCIAL_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error(
      "INSTAGRAM_SOCIAL_CLIENT_ID and INSTAGRAM_SOCIAL_CLIENT_SECRET must be set " +
        "(Meta app → Instagram product → 'API setup with Instagram login' → Instagram app ID/secret).",
    );
  }
  return { id, secret };
}

export function instagramSocialAuthorizeUrl(state: string, redirectUri: string): string {
  const { id } = instagramSocialCreds();
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set("client_id", id);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", SCOPES.join(","));
  u.searchParams.set("state", state);
  return u.toString();
}

async function readJson(resp: Response): Promise<Record<string, unknown>> {
  try {
    return (await resp.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function describeError(json: Record<string, unknown>): string {
  const err = json.error as { message?: string } | undefined;
  return String(json.error_message ?? err?.message ?? JSON.stringify(json)).slice(0, 200);
}

async function exchangeForLongLived(shortToken: string, secret: string): Promise<{ token: string; expiresIn: number }> {
  const u = new URL(`${INSTAGRAM_GRAPH_URL}/access_token`);
  u.searchParams.set("grant_type", "ig_exchange_token");
  u.searchParams.set("client_secret", secret);
  u.searchParams.set("access_token", shortToken);
  const resp = await fetch(u.toString(), { signal: AbortSignal.timeout(15_000) });
  const json = await readJson(resp);
  const token = typeof json.access_token === "string" ? json.access_token.trim() : "";
  if (!resp.ok || !token) {
    throw new Error(`Instagram long-lived exchange HTTP ${resp.status}: ${describeError(json)}`);
  }
  const expiresIn =
    typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : INSTAGRAM_LONG_LIVED_TTL_SEC;
  return { token, expiresIn };
}

async function fetchMe(token: string): Promise<{ userId: string; username: string }> {
  const resp = await fetch(
    `${INSTAGRAM_GRAPH_URL}/${INSTAGRAM_GRAPH_VERSION}/me?fields=user_id,username`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) },
  );
  const json = await readJson(resp);
  if (!resp.ok) throw new Error(`Instagram /me HTTP ${resp.status}: ${describeError(json)}`);
  const userId = String(json.user_id ?? json.id ?? "").trim();
  if (!userId) throw new Error("Instagram /me missing user_id");
  const username = typeof json.username === "string" && json.username.trim() ? json.username.trim() : userId;
  return { userId, username };
}

export async function instagramSocialExchangeCode(
  code: string,
  redirectUri: string,
): Promise<ConnectorExchangeResult> {
  const { id, secret } = instagramSocialCreds();
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      client_id: id,
      client_secret: secret,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code,
    }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const json = await readJson(resp);
  const shortToken = typeof json.access_token === "string" ? json.access_token.trim() : "";
  if (!resp.ok || !shortToken) {
    throw new Error(`Instagram token HTTP ${resp.status}: ${describeError(json)}`);
  }
  const permissions = Array.isArray(json.permissions)
    ? (json.permissions as unknown[]).map(String)
    : typeof json.permissions === "string"
      ? json.permissions.split(/[\s,]+/).filter(Boolean)
      : SCOPES;

  const { token, expiresIn } = await exchangeForLongLived(shortToken, secret);
  const me = await fetchMe(token);

  return {
    secrets: {
      [INSTAGRAM_SOCIAL_ACCESS_TOKEN_KEY]: token,
      [INSTAGRAM_SOCIAL_USER_ID_KEY]: me.userId,
      [INSTAGRAM_SOCIAL_USERNAME_KEY]: me.username,
    },
    expiresInSec: expiresIn,
    metadata: { team_id: me.userId, team_name: `@${me.username}`, scopes: permissions },
  };
}

export async function instagramSocialRefreshToken(tenant_id: string): Promise<ConnectorRefreshResult> {
  const current = await getSecret(tenant_id, INSTAGRAM_SOCIAL_ACCESS_TOKEN_KEY);
  if (!current) throw new Error("instagram_social not connected (no access token)");
  const u = new URL(`${INSTAGRAM_GRAPH_URL}/refresh_access_token`);
  u.searchParams.set("grant_type", "ig_refresh_token");
  u.searchParams.set("access_token", current);
  const resp = await fetch(u.toString(), { signal: AbortSignal.timeout(15_000) });
  const json = await readJson(resp);
  const token = typeof json.access_token === "string" ? json.access_token.trim() : "";
  if (!resp.ok || !token) {
    throw new Error(`Instagram refresh HTTP ${resp.status}: ${describeError(json)}`);
  }
  return {
    secrets: { [INSTAGRAM_SOCIAL_ACCESS_TOKEN_KEY]: token },
    expiresInSec:
      typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : INSTAGRAM_LONG_LIVED_TTL_SEC,
  };
}

export async function instagramSocialFetchIdentity(
  tenant_id: string,
): Promise<ConnectorIdentity | null> {
  const token = await getSecret(tenant_id, INSTAGRAM_SOCIAL_ACCESS_TOKEN_KEY);
  if (!token) return null;
  const me = await fetchMe(token);
  return { team_id: me.userId, team_name: `@${me.username}` };
}

export const instagramSocialConnector: ConnectorOAuth = {
  slug: INSTAGRAM_SOCIAL_SLUG,
  serverId: INSTAGRAM_SOCIAL_SLUG,
  scopes: SCOPES,
  authorizeUrl: instagramSocialAuthorizeUrl,
  exchangeCode: instagramSocialExchangeCode,
  refreshToken: instagramSocialRefreshToken,
  fetchIdentity: instagramSocialFetchIdentity,
};
