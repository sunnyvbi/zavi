
import { platformSecretRpc } from "@/services/tenant-client";
import { assertNoLabRefresh } from "@/services/connectors/core/lab-mode";

const AS_BASE = "https://mcp.higgsfield.ai";
const TOKEN_ENDPOINT = `${AS_BASE}/oauth2/token`;
export const HIGGSFIELD_MCP_URL = `${AS_BASE}/mcp`;

export const REFRESH_SECRET_KEY = "higgsfield.oauth.refresh_token";

const EXPIRY_SKEW_MS = 5 * 60_000;
const TOKEN_TIMEOUT_MS = 30_000;
const ROTATION_WAIT_ATTEMPTS = 4;
const ROTATION_WAIT_MS = 400;

type CachedToken = { token: string; expiresAtMs: number };
let _cache: CachedToken | null = null;
let _inflight: Promise<string> | null = null;

function redact(s: string, ...secrets: Array<string | undefined>): string {
  let out = s || "";
  for (const sec of secrets) {
    if (sec && sec.length >= 8) out = out.split(sec).join("«redacted»");
  }
  return out;
}

export type PlatformOauthConfig = { clientId: string; clientSecret?: string };

export function getPlatformOauthConfig(): PlatformOauthConfig | null {
  const clientId = (process.env.HIGGSFIELD_OAUTH_CLIENT_ID || "").trim();
  if (!clientId) return null;
  const clientSecret = (process.env.HIGGSFIELD_OAUTH_CLIENT_SECRET || "").trim();
  return { clientId, clientSecret: clientSecret || undefined };
}

export async function isPlatformMcpConfigured(): Promise<boolean> {
  if (!getPlatformOauthConfig()) return false;
  return (await readRefreshToken()) !== null;
}

async function readRefreshToken(): Promise<string | null> {
  const { data, error } = await platformSecretRpc("get_platform_secret", {
    p_key: REFRESH_SECRET_KEY,
  });
  if (error) throw new Error(`get_platform_secret failed: ${error.message}`);
  const v = typeof data === "string" ? data.trim() : "";
  return v.length > 0 ? v : null;
}

async function casRefreshToken(expected: string, next: string): Promise<boolean> {
  const { data, error } = await platformSecretRpc("rotate_platform_secret_cas", {
    p_key: REFRESH_SECRET_KEY,
    p_expected: expected,
    p_new: next,
    p_meta: { rotated_at: new Date().toISOString() },
  });
  if (error) throw new Error(`rotate_platform_secret_cas failed: ${error.message}`);
  return data === true;
}

export async function storeRefreshToken(refreshToken: string): Promise<void> {
  if (!refreshToken || refreshToken.length < 8) {
    throw new Error("storeRefreshToken: refusing an empty/short refresh token");
  }
  const { error } = await platformSecretRpc("set_platform_secret", {
    p_key: REFRESH_SECRET_KEY,
    p_value: refreshToken,
    p_meta: { seeded_at: new Date().toISOString() },
  });
  if (error) throw new Error(`set_platform_secret failed: ${error.message}`);
  _cache = null;
}

async function awaitRotatedToken(previous: string): Promise<string | null> {
  for (let i = 0; i < ROTATION_WAIT_ATTEMPTS; i++) {
    const current = await readRefreshToken();
    if (current && current !== previous) return current;
    if (i < ROTATION_WAIT_ATTEMPTS - 1) {
      await new Promise((r) => setTimeout(r, ROTATION_WAIT_MS));
    }
  }
  return null;
}

type MintOutcome =
  | { ok: true; accessToken: string; ttlMs: number }
  | { ok: false; consumed: true; error: string }
  | { ok: false; consumed: false; error: string };

async function mintWith(
  cfg: PlatformOauthConfig,
  refreshToken: string,
): Promise<MintOutcome> {
  assertNoLabRefresh("higgsfield");
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: cfg.clientId,
  });
  if (cfg.clientSecret) form.set("client_secret", cfg.clientSecret);

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    const error = `higgsfield token refresh ${res.status}: ${redact(text, refreshToken, cfg.clientSecret).slice(0, 240)}`;
    return { ok: false, consumed: /invalid_grant/i.test(text), error };
  }

  let body: { access_token?: string; refresh_token?: string; expires_in?: number };
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, consumed: false, error: "higgsfield token refresh returned non-JSON" };
  }
  if (!body.access_token) {
    return { ok: false, consumed: false, error: "higgsfield token refresh returned no access_token" };
  }

  if (body.refresh_token && body.refresh_token !== refreshToken) {
    await casRefreshToken(refreshToken, body.refresh_token);
  }

  return {
    ok: true,
    accessToken: body.access_token,
    ttlMs: Math.max(60_000, (body.expires_in ?? 3600) * 1000),
  };
}

async function mint(): Promise<string> {
  const cfg = getPlatformOauthConfig();
  if (!cfg) throw new Error("HIGGSFIELD_OAUTH_CLIENT_ID not set");

  const refreshToken = await readRefreshToken();
  if (!refreshToken) {
    throw new Error(
      `no ${REFRESH_SECRET_KEY} in platform_secrets — run scripts/higgsfield-oauth-bootstrap.mjs to authorize`,
    );
  }

  let out = await mintWith(cfg, refreshToken);

  if (!out.ok && out.consumed) {
    const rotated = await awaitRotatedToken(refreshToken);
    if (rotated) out = await mintWith(cfg, rotated);
  }

  if (!out.ok) throw new Error(out.error);

  _cache = { token: out.accessToken, expiresAtMs: Date.now() + out.ttlMs };
  return out.accessToken;
}

export async function getPlatformAccessToken(): Promise<string> {
  const now = Date.now();
  if (_cache && _cache.expiresAtMs - EXPIRY_SKEW_MS > now) return _cache.token;
  if (_inflight) return _inflight;

  const p = mint().finally(() => {
    _inflight = null;
  });
  _inflight = p;
  return p;
}

export function invalidatePlatformAccessToken(rejected: string): void {
  if (_cache?.token === rejected) _cache = null;
}

export function __resetTokenCacheForTests(): void {
  _cache = null;
  _inflight = null;
}
