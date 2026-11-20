
import type { ConnectorExchangeResult, ConnectorRefreshResult } from "./types";
import { getSecret } from "@/services/secrets/vault";
import { assertNoLabRefresh } from "./lab-mode";

export type OAuth2Identity = {
  team_id: string;
  team_name: string;
  extraSecrets?: Record<string, string>;
};

export type OAuth2AuthCodeConfig = {
  slug: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: readonly string[];
  scopeSeparator?: string;
  clientAuth: "body" | "basic";
  extraAuthorizeParams?: Record<string, string>;
  extraExchangeParams?: Record<string, string>;
  extraRefreshParams?: Record<string, string>;
  creds: () => { id: string; secret: string };
  accessTokenKey: string;
  refreshTokenKey: string;
  defaultTtlSec: number;
  identify: (accessToken: string) => Promise<OAuth2Identity>;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
};

export class OAuthTokenError extends Error {
  readonly status: number;
  readonly oauthError: string | null;
  readonly refreshTokenDead: boolean;
  constructor(message: string, status: number, oauthError: string | null, refreshTokenDead = false) {
    super(message);
    this.name = "OAuthTokenError";
    this.status = status;
    this.oauthError = oauthError;
    this.refreshTokenDead = refreshTokenDead;
  }
}

const DEAD_REFRESH_TOKEN = /refresh[ _-]?token[^.]*\b(expired|revoked)\b|\b(expired|revoked)\b[^.]*refresh[ _-]?token/i;

function saysRefreshTokenDead(text: string): boolean {
  try {
    const said = (JSON.parse(text) as { error_description?: unknown }).error_description;
    return typeof said === "string" && DEAD_REFRESH_TOKEN.test(said);
  } catch {
    return false;
  }
}

function oauthErrorCode(text: string): string | null {
  try {
    const code = (JSON.parse(text) as { error?: unknown }).error;
    return typeof code === "string" && /^[a-z_]{1,64}$/i.test(code) ? code : null;
  } catch {
    return null;
  }
}

function ttl(json: TokenResponse, fallback: number): number {
  return typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : fallback;
}

async function postToken(cfg: OAuth2AuthCodeConfig, params: URLSearchParams): Promise<TokenResponse> {
  const { id, secret } = cfg.creds();
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (cfg.clientAuth === "basic") {
    headers.Authorization = `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
  } else {
    params.set("client_id", id);
    params.set("client_secret", secret);
  }
  const resp = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers,
    body: params.toString(),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new OAuthTokenError(`${cfg.slug} token HTTP ${resp.status}`, resp.status, oauthErrorCode(text), saysRefreshTokenDead(text));
  }
  let json: TokenResponse;
  try {
    json = JSON.parse(text) as TokenResponse;
  } catch {
    throw new Error(`${cfg.slug} token response was not JSON`);
  }
  if (json.error) throw new OAuthTokenError(`${cfg.slug} token error: ${json.error}`, resp.status, oauthErrorCode(text), saysRefreshTokenDead(text));
  return json;
}

export function oauth2AuthCode(cfg: OAuth2AuthCodeConfig): {
  authorizeUrl: (state: string, redirectUri: string) => string;
  exchangeCode: (code: string, redirectUri: string) => Promise<ConnectorExchangeResult>;
  refreshToken: (tenant_id: string) => Promise<ConnectorRefreshResult>;
} {
  const sep = cfg.scopeSeparator ?? " ";

  return {
    authorizeUrl(state, redirectUri) {
      const { id } = cfg.creds();
      const u = new URL(cfg.authorizeUrl);
      u.searchParams.set("client_id", id);
      u.searchParams.set("response_type", "code");
      u.searchParams.set("redirect_uri", redirectUri);
      u.searchParams.set("state", state);
      if (cfg.scopes.length > 0) u.searchParams.set("scope", cfg.scopes.join(sep));
      for (const [k, v] of Object.entries(cfg.extraAuthorizeParams ?? {})) u.searchParams.set(k, v);
      return u.toString();
    },

    async exchangeCode(code, redirectUri) {
      const json = await postToken(
        cfg,
        new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          ...(cfg.extraExchangeParams ?? {}),
        }),
      );
      const access_token = json.access_token?.trim() ?? "";
      const refresh_token = json.refresh_token?.trim() ?? "";
      if (!access_token) throw new Error(`${cfg.slug} token response missing access_token`);
      if (!refresh_token) {
        throw new Error(
          `${cfg.slug} token response missing refresh_token — the connection would die in ${ttl(json, cfg.defaultTtlSec)}s`,
        );
      }
      const who = await cfg.identify(access_token);
      const secrets: Record<string, string> = {
        [cfg.accessTokenKey]: access_token,
        [cfg.refreshTokenKey]: refresh_token,
        ...(who.extraSecrets ?? {}),
      };
      if (typeof json.refresh_token_expires_in === "number") {
        secrets[`${cfg.slug}.refresh_expires_at`] = new Date(
          Date.now() + json.refresh_token_expires_in * 1000,
        ).toISOString();
      }
      return {
        secrets,
        expiresInSec: ttl(json, cfg.defaultTtlSec),
        metadata: {
          team_id: who.team_id,
          team_name: who.team_name,
          scopes: (json.scope ?? cfg.scopes.join(sep)).split(/[\s,]+/).filter(Boolean),
        },
      };
    },

    async refreshToken(tenant_id) {
      assertNoLabRefresh(cfg.slug);
      const current = await getSecret(tenant_id, cfg.refreshTokenKey);
      if (!current) throw new Error(`${cfg.slug} not connected (no refresh token)`);
      const json = await postToken(
        cfg,
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: current,
          ...(cfg.extraRefreshParams ?? {}),
        }),
      );
      const access_token = json.access_token?.trim() ?? "";
      if (!access_token) throw new Error(`${cfg.slug} refresh response missing access_token`);
      return {
        secrets: {
          [cfg.accessTokenKey]: access_token,
          [cfg.refreshTokenKey]: json.refresh_token?.trim() || current,
        },
        expiresInSec: ttl(json, cfg.defaultTtlSec),
      };
    },
  };
}
