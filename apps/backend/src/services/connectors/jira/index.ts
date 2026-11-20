
import type {
  ConnectorOAuth,
  ConnectorExchangeResult,
  ConnectorRefreshResult,
} from "../core/types";
import { getSecret } from "@/services/secrets/vault";
import { assertNoLabRefresh } from "@/services/connectors/core/lab-mode";

const AUTHORIZE_URL = "https://auth.atlassian.com/authorize";
const TOKEN_URL = "https://auth.atlassian.com/oauth/token";
const RESOURCES_URL =
  "https://api.atlassian.com/oauth/token/accessible-resources";

const SCOPES = [
  "read:jira-work",
  "write:jira-work",
  "read:jira-user",
  "offline_access",
];

function creds(): { id: string; secret: string } {
  const id = process.env.JIRA_CLIENT_ID;
  const secret = process.env.JIRA_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error(
      "JIRA_CLIENT_ID and JIRA_CLIENT_SECRET must be set (Atlassian developer console 3LO app).",
    );
  }
  return { id, secret };
}

type TokenResp = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
};

async function tokenRequest(
  body: Record<string, string>,
): Promise<TokenResp> {
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`Atlassian token endpoint HTTP ${resp.status}`);
  }
  const json = (await resp.json()) as Record<string, unknown>;
  const access_token = String(json.access_token ?? "");
  if (!access_token) {
    throw new Error(
      `Atlassian token response missing access_token: ${String(json.error ?? "unknown")}`,
    );
  }
  return {
    access_token,
    refresh_token: json.refresh_token ? String(json.refresh_token) : undefined,
    expires_in: Number(json.expires_in ?? 3600),
  };
}

async function resolveCloudId(accessToken: string): Promise<{
  cloud_id: string;
  site_name: string;
}> {
  const resp = await fetch(RESOURCES_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!resp.ok) {
    throw new Error(`Atlassian accessible-resources HTTP ${resp.status}`);
  }
  const sites = (await resp.json()) as Array<{ id: string; name?: string; url?: string }>;
  if (!Array.isArray(sites) || sites.length === 0) {
    throw new Error("No accessible Atlassian site for this token.");
  }
  if (sites.length > 1) {
    throw new Error(
      `This Atlassian account has ${sites.length} sites; single-site only in v1. ` +
        `Connect with an account scoped to one site, or contact Zavi support.`,
    );
  }
  return { cloud_id: sites[0].id, site_name: sites[0].name ?? sites[0].url ?? sites[0].id };
}

export const jiraConnector: ConnectorOAuth = {
  slug: "jira",
  serverId: "jira",
  scopes: SCOPES,

  authorizeUrl(state: string, redirectUri: string): string {
    const { id } = creds();
    const u = new URL(AUTHORIZE_URL);
    u.searchParams.set("audience", "api.atlassian.com");
    u.searchParams.set("client_id", id);
    u.searchParams.set("scope", SCOPES.join(" "));
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("state", state);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("prompt", "consent");
    return u.toString();
  },

  async exchangeCode(
    code: string,
    redirectUri: string,
  ): Promise<ConnectorExchangeResult> {
    const { id, secret } = creds();
    const tok = await tokenRequest({
      grant_type: "authorization_code",
      client_id: id,
      client_secret: secret,
      code,
      redirect_uri: redirectUri,
    });
    const { cloud_id, site_name } = await resolveCloudId(tok.access_token);
    const secrets: Record<string, string> = {
      "jira.access_token": tok.access_token,
      "jira.cloud_id": cloud_id,
    };
    if (tok.refresh_token) secrets["jira.refresh_token"] = tok.refresh_token;
    return {
      secrets,
      expiresInSec: tok.expires_in,
      metadata: { team_id: cloud_id, team_name: site_name, scopes: SCOPES },
    };
  },

  async refreshToken(tenant_id: string): Promise<ConnectorRefreshResult> {
    assertNoLabRefresh("jira");
    const { id, secret } = creds();
    const refresh = await getSecret(tenant_id, "jira.refresh_token");
    if (!refresh) {
      throw new Error("jira.refresh_token missing — operator must reconnect JIRA.");
    }
    const tok = await tokenRequest({
      grant_type: "refresh_token",
      client_id: id,
      client_secret: secret,
      refresh_token: refresh,
    });
    const secrets: Record<string, string> = {
      "jira.access_token": tok.access_token,
    };
    if (tok.refresh_token) secrets["jira.refresh_token"] = tok.refresh_token;
    return { secrets, expiresInSec: tok.expires_in };
  },
};
