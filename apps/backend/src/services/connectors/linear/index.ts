
import type {
  ConnectorOAuth,
  ConnectorExchangeResult,
} from "../core/types";

const AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const TOKEN_URL = "https://api.linear.app/oauth/token";
const GRAPHQL_URL = "https://api.linear.app/graphql";

const SCOPES = ["read", "write"];

function creds(): { id: string; secret: string } {
  const id = process.env.LINEAR_CLIENT_ID;
  const secret = process.env.LINEAR_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error(
      "LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET must be set (Linear OAuth application).",
    );
  }
  return { id, secret };
}

async function resolveOrg(
  accessToken: string,
): Promise<{ org_id: string; org_name: string }> {
  const resp = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: accessToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: "{ organization { id name } }" }),
  });
  if (!resp.ok) {
    throw new Error(`Linear GraphQL HTTP ${resp.status}`);
  }
  const json = (await resp.json()) as {
    data?: { organization?: { id?: string; name?: string } };
  };
  const org = json.data?.organization;
  if (!org?.id) {
    throw new Error("Linear organization query returned no id.");
  }
  return { org_id: org.id, org_name: org.name ?? org.id };
}

export const linearConnector: ConnectorOAuth = {
  slug: "linear",
  serverId: "linear",
  scopes: SCOPES,

  authorizeUrl(state: string, redirectUri: string): string {
    const { id } = creds();
    const u = new URL(AUTHORIZE_URL);
    u.searchParams.set("client_id", id);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", SCOPES.join(","));
    u.searchParams.set("state", state);
    u.searchParams.set("prompt", "consent");
    return u.toString();
  },

  async exchangeCode(
    code: string,
    redirectUri: string,
  ): Promise<ConnectorExchangeResult> {
    const { id, secret } = creds();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: id,
      client_secret: secret,
      code,
      redirect_uri: redirectUri,
    });
    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!resp.ok) {
      throw new Error(`Linear token endpoint HTTP ${resp.status}`);
    }
    const json = (await resp.json()) as Record<string, unknown>;
    const access_token = String(json.access_token ?? "");
    if (!access_token) {
      throw new Error(
        `Linear token response missing access_token: ${String(json.error ?? "unknown")}`,
      );
    }
    const { org_id, org_name } = await resolveOrg(access_token);
    return {
      secrets: { "linear.access_token": access_token },
      metadata: { team_id: org_id, team_name: org_name, scopes: SCOPES },
    };
  },
};
