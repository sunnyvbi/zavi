
import type { ConnectorOAuth, ConnectorExchangeResult } from "../core/types";

const AUTHORIZE_URL = "https://app.intercom.com/oauth";
const TOKEN_URL = "https://api.intercom.io/auth/eagle/token";
const ME_URL = "https://api.intercom.io/me";

const SCOPES = ["read_conversations"];

function creds(): { id: string; secret: string } {
  const id = process.env.INTERCOM_CLIENT_ID;
  const secret = process.env.INTERCOM_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error(
      "INTERCOM_CLIENT_ID and INTERCOM_CLIENT_SECRET must be set (Intercom OAuth application, Developer Hub).",
    );
  }
  return { id, secret };
}

async function resolveWorkspace(
  accessToken: string,
): Promise<{ team_id: string; team_name: string }> {
  const resp = await fetch(ME_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (!resp.ok) {
    throw new Error(`Intercom /me HTTP ${resp.status}`);
  }
  const json = (await resp.json()) as {
    app?: { id_code?: string; name?: string };
    id?: string;
  };
  const app = json.app;
  const team_id = app?.id_code ?? json.id ?? "";
  if (!team_id) {
    throw new Error("Intercom /me returned no app id_code.");
  }
  return { team_id, team_name: app?.name ?? team_id };
}

export const intercomConnector: ConnectorOAuth = {
  slug: "intercom",
  serverId: "intercom",
  scopes: SCOPES,

  authorizeUrl(state: string, redirectUri: string): string {
    const { id } = creds();
    const u = new URL(AUTHORIZE_URL);
    u.searchParams.set("client_id", id);
    u.searchParams.set("state", state);
    u.searchParams.set("redirect_uri", redirectUri);
    return u.toString();
  },

  async exchangeCode(
    code: string,
    redirectUri: string,
  ): Promise<ConnectorExchangeResult> {
    const { id, secret } = creds();
    const body = new URLSearchParams({
      code,
      client_id: id,
      client_secret: secret,
      redirect_uri: redirectUri,
    });
    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    });
    if (!resp.ok) {
      throw new Error(`Intercom token endpoint HTTP ${resp.status}`);
    }
    const json = (await resp.json()) as Record<string, unknown>;
    const access_token = String(json.access_token ?? json.token ?? "");
    if (!access_token) {
      throw new Error(
        `Intercom token response missing access_token: ${String(json.error ?? "unknown")}`,
      );
    }
    const { team_id, team_name } = await resolveWorkspace(access_token);
    return {
      secrets: { "intercom.access_token": access_token },
      metadata: { team_id, team_name, scopes: SCOPES },
    };
  },
};
