
import crypto from "node:crypto";
import { platformSecretRpc } from "@/services/tenant-client";
import type { ConnectorOAuth } from "@/services/connectors/core/types";
import { assertNoLabRefresh } from "@/services/connectors/core/lab-mode";

const AS_BASE = "https://mcp.higgsfield.ai";
export const HIGGSFIELD_MCP_URL = `${AS_BASE}/mcp`;
const SCOPES = "openid email offline_access";
const HTTP_TIMEOUT_MS = 30_000;

const CLIENT_SECRET_KEY = "higgsfield.oauth.tenant_client";

export type HiggsfieldTokens = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
};

type OauthClient = { client_id: string; client_secret?: string };

export function callbackUrl(): string {
  const base = (process.env.BACKEND_PUBLIC_URL || "https://api.zaviagent.com").replace(/\/+$/, "");
  return `${base}/api/connectors/higgsfield/callback`;
}

function verifierSecret(): string {
  const s = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.INNGEST_SIGNING_KEY || "").trim();
  if (!s) throw new Error("higgsfield oauth: no server secret available to derive the PKCE verifier");
  return s;
}

export function deriveVerifier(state: string): string {
  return crypto.createHmac("sha256", verifierSecret()).update(`higgsfield:${state}`).digest("base64url");
}

function challengeFor(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

async function jsonFetch(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${url} -> ${res.status}: ${text.slice(0, 240)}`);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${url} returned non-JSON`);
  }
}

async function discover(): Promise<{ authorization_endpoint: string; token_endpoint: string; registration_endpoint: string }> {
  const meta = (await jsonFetch(`${AS_BASE}/.well-known/oauth-authorization-server`, { method: "GET" })) as Record<string, string>;
  for (const k of ["authorization_endpoint", "token_endpoint", "registration_endpoint"]) {
    if (!meta[k]) throw new Error(`higgsfield oauth metadata missing ${k}`);
  }
  return meta as never;
}

async function readCachedClient(): Promise<OauthClient | null> {
  const { data, error } = await platformSecretRpc("get_platform_secret", { p_key: CLIENT_SECRET_KEY });
  if (error) throw new Error(`get_platform_secret failed: ${error.message}`);
  if (typeof data !== "string" || !data.trim()) return null;
  try {
    const parsed = JSON.parse(data) as OauthClient;
    return parsed.client_id ? parsed : null;
  } catch {
    return null;
  }
}

export async function getTenantOauthClient(): Promise<OauthClient> {
  const cached = await readCachedClient();
  if (cached) return cached;

  const meta = await discover();
  const reg = (await jsonFetch(meta.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Zavi (customer workspaces)",
      redirect_uris: [callbackUrl()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
      scope: SCOPES,
    }),
  })) as { client_id?: string; client_secret?: string };

  if (!reg.client_id) throw new Error("higgsfield client registration returned no client_id");
  const client: OauthClient = { client_id: reg.client_id, client_secret: reg.client_secret };

  const { data: won, error } = await platformSecretRpc("rotate_platform_secret_cas", {
    p_key: CLIENT_SECRET_KEY,
    p_expected: null,
    p_new: JSON.stringify(client),
    p_meta: { registered_at: new Date().toISOString(), redirect_uri: callbackUrl() },
  });
  if (error) throw new Error(`rotate_platform_secret_cas failed: ${error.message}`);
  if (won === false) {
    const winner = await readCachedClient();
    if (winner) return winner;
  }
  return client;
}

export async function higgsfieldAuthorizeUrl(state: string): Promise<string> {
  const [meta, client] = await Promise.all([discover(), getTenantOauthClient()]);
  const url = new URL(meta.authorization_endpoint);
  for (const [k, v] of Object.entries({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: callbackUrl(),
    scope: SCOPES,
    state,
    code_challenge: challengeFor(deriveVerifier(state)),
    code_challenge_method: "S256",
    prompt: "consent",
    resource: HIGGSFIELD_MCP_URL,
  })) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

export async function exchangeHiggsfieldCode(code: string, state: string): Promise<HiggsfieldTokens> {
  const [meta, client] = await Promise.all([discover(), getTenantOauthClient()]);
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: callbackUrl(),
    client_id: client.client_id,
    code_verifier: deriveVerifier(state),
  });
  if (client.client_secret) form.set("client_secret", client.client_secret);

  const tok = (await jsonFetch(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  })) as HiggsfieldTokens;

  if (!tok.access_token) throw new Error("higgsfield token exchange returned no access_token");
  return tok;
}

export const HIGGSFIELD_ACCESS_TOKEN_KEY = "higgsfield.access_token";
export const HIGGSFIELD_REFRESH_TOKEN_KEY = "higgsfield.refresh_token";
const HIGGSFIELD_ACCESS_TOKEN_TTL_SEC = 86_400;

export async function higgsfieldRefreshToken(
  tenant_id: string,
): Promise<{ secrets: Record<string, string>; expiresInSec: number }> {
  assertNoLabRefresh("higgsfield");
  const { getSecret } = await import("@/services/secrets/vault");
  const current = await getSecret(tenant_id, HIGGSFIELD_REFRESH_TOKEN_KEY);
  if (!current) throw new Error("higgsfield not connected (no refresh token)");

  const [meta, client] = await Promise.all([discover(), getTenantOauthClient()]);
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: current,
    client_id: client.client_id,
  });
  if (client.client_secret) form.set("client_secret", client.client_secret);

  const json = (await jsonFetch(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  })) as { access_token?: string; refresh_token?: string; expires_in?: number };

  const access_token = json.access_token?.trim() ?? "";
  if (!access_token) throw new Error("higgsfield refresh response missing access_token");

  return {
    secrets: {
      [HIGGSFIELD_ACCESS_TOKEN_KEY]: access_token,
      [HIGGSFIELD_REFRESH_TOKEN_KEY]: json.refresh_token?.trim() || current,
    },
    expiresInSec:
      typeof json.expires_in === "number" && json.expires_in > 0
        ? json.expires_in
        : HIGGSFIELD_ACCESS_TOKEN_TTL_SEC,
  };
}

export const higgsfieldOauthConnector: ConnectorOAuth = {
  slug: "higgsfield",
  serverId: "higgsfield",
  scopes: SCOPES.split(" "),
  refreshToken: higgsfieldRefreshToken,

  authorizeUrl(): string {
    throw new Error(
      "higgsfield uses its own OAuth routes (/api/connectors/higgsfield/start) — the generic handler cannot build its authorize URL",
    );
  },
  exchangeCode(): Promise<never> {
    throw new Error(
      "higgsfield uses its own OAuth routes (/api/connectors/higgsfield/callback) — the generic handler cannot exchange its code",
    );
  },
};
