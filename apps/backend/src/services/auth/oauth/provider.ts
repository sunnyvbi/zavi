
import type { Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  InvalidTargetError,
  ServerError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { randomUUID } from "node:crypto";
import { serviceClient } from "@/services/supabase";
import { _verifyHashConstantTime } from "@/services/auth/pat";
import { praxisClientsStore } from "./clients-store";
import { signConsentState } from "./state";
import { verifyAccessToken } from "./verifier";
import {
  MCP_RESOURCE,
  ACCESS_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
  OAT_PREFIX,
  ORT_PREFIX,
  CODE_PREFIX,
  PREFIX_LOOKUP_LEN,
  generateToken,
} from "./tokens";

const SUPPORTED_SCOPES = ["read", "run", "offline_access"];
const WEB_ORIGIN = process.env.PRAXIS_WEB_ORIGIN ?? "https://www.zaviagent.com";
const MAX_PREFIX_CANDIDATES = 5;

function tokenResponse(
  accessRaw: string,
  refreshRaw: string | null,
  scopes: string[],
): OAuthTokens {
  return {
    access_token: accessRaw,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_SECONDS,
    ...(refreshRaw ? { refresh_token: refreshRaw } : {}),
    scope: scopes.join(" "),
  };
}

export const praxisOAuthProvider: OAuthServerProvider = {
  get clientsStore(): OAuthRegisteredClientsStore {
    return praxisClientsStore;
  },

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const requested = params.scopes ?? [];
    for (const s of requested) {
      if (!SUPPORTED_SCOPES.includes(s)) {
        throw new InvalidScopeError(`unsupported scope: ${s}`);
      }
    }
    if (params.resource && params.resource.href !== MCP_RESOURCE) {
      throw new InvalidTargetError("unknown resource");
    }
    const signed = signConsentState({
      client_id: client.client_id,
      redirect_uri: params.redirectUri,
      code_challenge: params.codeChallenge,
      state: params.state,
      scopes: requested,
      resource: MCP_RESOURCE,
    });
    res.redirect(
      302,
      `${WEB_ORIGIN}/oauth/consent?req=${encodeURIComponent(signed)}`,
    );
  },

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const row = await findAuthCode(client.client_id, authorizationCode);
    return row.code_challenge;
  },

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const row = await findAuthCode(client.client_id, authorizationCode);
    if (redirectUri && redirectUri !== row.redirect_uri) {
      throw new InvalidGrantError("redirect_uri mismatch");
    }
    if (resource && resource.href !== MCP_RESOURCE) {
      throw new InvalidTargetError("resource mismatch");
    }

    const sb = serviceClient();
    const { data: consumed, error: cErr } = await sb.rpc("consume_oauth_code", {
      p_id: row.id,
    });
    if (cErr || !consumed || (consumed as unknown[]).length === 0) {
      throw new InvalidGrantError("authorization code already used or expired");
    }
    const c = (consumed as Array<Record<string, unknown>>)[0];
    const scopes = (c.scopes as string[]) ?? [];
    const familyId = randomUUID();
    const access = generateToken(OAT_PREFIX);
    const issueRefresh = scopes.includes("offline_access");
    const refresh = issueRefresh ? generateToken(ORT_PREFIX) : null;

    const { error: mErr } = await sb.rpc("mint_oauth_tokens", {
      p_family_id: familyId,
      p_client_id: client.client_id,
      p_user_id: c.user_id,
      p_tenant_id: c.tenant_id,
      p_scopes: scopes,
      p_resource: MCP_RESOURCE,
      p_access_hash: access.hash,
      p_access_salt: access.salt,
      p_access_prefix: access.prefix,
      p_access_ttl: ACCESS_TTL_SECONDS,
      p_issue_refresh: issueRefresh,
      p_refresh_hash: refresh ? refresh.hash : null,
      p_refresh_salt: refresh ? refresh.salt : null,
      p_refresh_prefix: refresh ? refresh.prefix : null,
      p_refresh_ttl: REFRESH_TTL_SECONDS,
    });
    if (mErr) throw new ServerError(`mint_oauth_tokens failed: ${mErr.message}`);
    return tokenResponse(access.raw, refresh ? refresh.raw : null, scopes);
  },

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    if (resource && resource.href !== MCP_RESOURCE) {
      throw new InvalidTargetError("resource mismatch");
    }
    const old = await findRefreshRow(client.client_id, refreshToken);
    const sb = serviceClient();
    const access = generateToken(OAT_PREFIX);
    const refresh = generateToken(ORT_PREFIX);
    const { data, error } = await sb.rpc("rotate_oauth_refresh", {
      p_old_id: old.id,
      p_access_hash: access.hash,
      p_access_salt: access.salt,
      p_access_prefix: access.prefix,
      p_access_ttl: ACCESS_TTL_SECONDS,
      p_refresh_hash: refresh.hash,
      p_refresh_salt: refresh.salt,
      p_refresh_prefix: refresh.prefix,
      p_refresh_ttl: REFRESH_TTL_SECONDS,
    });
    if (error) {
      throw new ServerError(`rotate_oauth_refresh failed: ${error.message}`);
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || !row.access_id) {
      throw new InvalidGrantError("refresh token invalid or reused");
    }
    return tokenResponse(access.raw, refresh.raw, old.scopes);
  },

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    return verifyAccessToken(token);
  },

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    const raw = request.token;
    if (!raw.startsWith(OAT_PREFIX) && !raw.startsWith(ORT_PREFIX)) return;
    const prefix = raw.slice(0, PREFIX_LOOKUP_LEN);
    await serviceClient().rpc("revoke_oauth_token", { p_token_prefix: prefix });
  },
};

type AuthCodeRow = {
  id: string;
  redirect_uri: string;
  code_challenge: string;
};

async function findAuthCode(
  clientId: string,
  rawCode: string,
): Promise<AuthCodeRow> {
  if (!rawCode.startsWith(CODE_PREFIX)) {
    throw new InvalidGrantError("invalid authorization code");
  }
  const sb = serviceClient();
  const prefix = rawCode.slice(0, PREFIX_LOOKUP_LEN);
  const { data: rows, error } = await sb
    .from("oauth_auth_codes")
    .select("id,code_hash,code_salt,client_id,redirect_uri,code_challenge,expires_at")
    .eq("code_prefix", prefix)
    .is("consumed_at", null);
  if (error || !rows || rows.length === 0 || rows.length > MAX_PREFIX_CANDIDATES) {
    throw new InvalidGrantError("invalid authorization code");
  }
  const match = rows.find((r) =>
    _verifyHashConstantTime(rawCode, r.code_salt as string, r.code_hash as string),
  );
  if (!match) throw new InvalidGrantError("invalid authorization code");
  if (match.client_id !== clientId) {
    throw new InvalidGrantError("authorization code was issued to another client");
  }
  if (new Date(match.expires_at as string) < new Date()) {
    throw new InvalidGrantError("authorization code expired");
  }
  return {
    id: match.id as string,
    redirect_uri: match.redirect_uri as string,
    code_challenge: match.code_challenge as string,
  };
}

type RefreshRow = { id: string; scopes: string[] };

async function findRefreshRow(
  clientId: string,
  rawToken: string,
): Promise<RefreshRow> {
  if (!rawToken.startsWith(ORT_PREFIX)) {
    throw new InvalidGrantError("invalid refresh token");
  }
  const sb = serviceClient();
  const prefix = rawToken.slice(0, PREFIX_LOOKUP_LEN);
  const { data: rows, error } = await sb
    .from("oauth_refresh_tokens")
    .select("id,token_hash,token_salt,client_id,scopes")
    .eq("token_prefix", prefix);
  if (error || !rows || rows.length === 0 || rows.length > MAX_PREFIX_CANDIDATES) {
    throw new InvalidGrantError("invalid refresh token");
  }
  const match = rows.find((r) =>
    _verifyHashConstantTime(rawToken, r.token_salt as string, r.token_hash as string),
  );
  if (!match) throw new InvalidGrantError("invalid refresh token");
  if (match.client_id !== clientId) {
    throw new InvalidGrantError("refresh token was issued to another client");
  }
  return { id: match.id as string, scopes: (match.scopes as string[]) ?? [] };
}
