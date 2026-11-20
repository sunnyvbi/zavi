
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { serviceClient } from "@/services/supabase";

const RESOURCE_HTTPS = /^https:\/\//i;
const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i;

export function isAllowedRedirectUri(uri: string): boolean {
  return RESOURCE_HTTPS.test(uri) || LOOPBACK.test(uri);
}

function rowToClient(row: Record<string, unknown>): OAuthClientInformationFull {
  const scopes = (row.scopes as string[] | null) ?? [];
  return {
    client_id: row.client_id as string,
    redirect_uris: (row.redirect_uris as string[]) ?? [],
    token_endpoint_auth_method: "none",
    grant_types: (row.grant_types as string[]) ?? [
      "authorization_code",
      "refresh_token",
    ],
    response_types: (row.response_types as string[]) ?? ["code"],
    client_name: (row.client_name as string | null) ?? undefined,
    scope: scopes.length ? scopes.join(" ") : undefined,
  } as OAuthClientInformationFull;
}

export const praxisClientsStore: OAuthRegisteredClientsStore = {
  async getClient(clientId) {
    const sb = serviceClient();
    const { data, error } = await sb
      .from("oauth_clients")
      .select("client_id,client_name,redirect_uris,grant_types,response_types,scopes")
      .eq("client_id", clientId)
      .maybeSingle();
    if (error || !data) return undefined;
    return rowToClient(data);
  },

  async registerClient(client) {
    const c = client as OAuthClientInformationFull;
    const redirectUris = c.redirect_uris ?? [];
    for (const uri of redirectUris) {
      if (!isAllowedRedirectUri(uri)) {
        throw new Error(
          `redirect_uri must be https or loopback http: ${uri}`,
        );
      }
    }
    const scopes = c.scope ? c.scope.split(/\s+/).filter(Boolean) : [];
    const sb = serviceClient();
    const { error } = await sb.from("oauth_clients").insert({
      client_id: c.client_id,
      client_name: c.client_name ?? null,
      redirect_uris: redirectUris,
      grant_types: c.grant_types ?? ["authorization_code", "refresh_token"],
      response_types: c.response_types ?? ["code"],
      scopes,
      token_endpoint_auth_method: "none",
    });
    if (error) throw new Error(`oauth_clients insert failed: ${error.message}`);
    return rowToClient({
      client_id: c.client_id,
      client_name: c.client_name ?? null,
      redirect_uris: redirectUris,
      grant_types: c.grant_types ?? ["authorization_code", "refresh_token"],
      response_types: c.response_types ?? ["code"],
      scopes,
    });
  },
};
