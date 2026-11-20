
import type { ConnectorExchangeResult } from "../core/types";
import {
  LINKEDIN_SOCIAL_AUTHOR_URN_KEY,
  LINKEDIN_SOCIAL_SLUG,
  LINKEDIN_SOCIAL_TOKEN_KEY,
} from "./constants";

const AUTHORIZE_URL = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const USERINFO_URL = "https://api.linkedin.com/v2/userinfo";

const SCOPES = ["openid", "profile", "w_member_social"];

export function linkedinSocialCreds(): { id: string; secret: string } {
  const id = process.env.LINKEDIN_SOCIAL_CLIENT_ID ?? process.env.LINKEDIN_CLIENT_ID;
  const secret =
    process.env.LINKEDIN_SOCIAL_CLIENT_SECRET ?? process.env.LINKEDIN_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error(
      "LINKEDIN_SOCIAL_CLIENT_ID and LINKEDIN_SOCIAL_CLIENT_SECRET must be set " +
        "(LinkedIn Developer app with Share on LinkedIn + Sign In with OpenID Connect).",
    );
  }
  return { id, secret };
}

export function linkedinSocialAuthorizeUrl(state: string, redirectUri: string): string {
  const { id } = linkedinSocialCreds();
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", id);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  u.searchParams.set("scope", SCOPES.join(" "));
  return u.toString();
}

async function fetchUserInfo(accessToken: string): Promise<{
  sub: string;
  name: string;
}> {
  const resp = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    throw new Error(`LinkedIn userinfo HTTP ${resp.status}`);
  }
  const json = (await resp.json()) as { sub?: string; name?: string };
  const sub = json.sub?.trim() ?? "";
  if (!sub) {
    throw new Error("LinkedIn userinfo missing sub");
  }
  return { sub, name: json.name?.trim() || sub };
}

export async function linkedinSocialExchangeCode(
  code: string,
  redirectUri: string,
): Promise<ConnectorExchangeResult> {
  const { id, secret } = linkedinSocialCreds();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: id,
    client_secret: secret,
  });
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`LinkedIn token HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  const json = (await resp.json()) as {
    access_token?: string;
    expires_in?: number;
    scope?: string;
  };
  const access_token = json.access_token?.trim() ?? "";
  if (!access_token) {
    throw new Error("LinkedIn token response missing access_token");
  }
  const { sub, name } = await fetchUserInfo(access_token);
  const authorUrn = `urn:li:person:${sub}`;
  const expiresInSec =
    typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 60 * 24 * 60 * 60;

  return {
    secrets: {
      [LINKEDIN_SOCIAL_TOKEN_KEY]: access_token,
      [LINKEDIN_SOCIAL_AUTHOR_URN_KEY]: authorUrn,
    },
    expiresInSec,
    metadata: {
      team_id: sub,
      team_name: name,
      scopes: (json.scope ?? SCOPES.join(" ")).split(/[\s,]+/).filter(Boolean),
    },
  };
}

export const linkedinSocialConnector: import("../core/types").ConnectorOAuth = {
  slug: LINKEDIN_SOCIAL_SLUG,
  serverId: LINKEDIN_SOCIAL_SLUG,
  scopes: SCOPES,
  authorizeUrl: linkedinSocialAuthorizeUrl,
  exchangeCode: linkedinSocialExchangeCode,
};
