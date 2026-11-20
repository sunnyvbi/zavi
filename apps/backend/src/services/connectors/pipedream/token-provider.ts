
import { getPipedreamCreds, PIPEDREAM_API_BASE_URL, type PipedreamCreds } from "./creds";
import { assertStreamableUrlAllowed } from "@/services/mcp/streamable-guards";

type CachedToken = { token: string; expiresAtMs: number };

const SKEW_MS = 60_000;
const DEFAULT_EXPIRES_IN_S = 3600;
const MINT_TIMEOUT_MS = 15_000;

const _cache = new Map<string, CachedToken>();
const _inflight = new Map<string, Promise<string>>();

function cacheKey(c: PipedreamCreds): string {
  return `${c.projectId}:${c.environment}:${c.clientId}`;
}

async function mint(creds: PipedreamCreds): Promise<{ token: string; expiresInS: number }> {
  const url = `${PIPEDREAM_API_BASE_URL}/oauth/token`;
  assertStreamableUrlAllowed(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MINT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
      }),
      signal: controller.signal,
      redirect: "manual",
    });
    if (!res.ok) {
      throw new Error(`pipedream oauth token mint failed: HTTP ${res.status}`);
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) {
      throw new Error("pipedream oauth token mint: no access_token in response");
    }
    return { token: json.access_token, expiresInS: json.expires_in ?? DEFAULT_EXPIRES_IN_S };
  } finally {
    clearTimeout(timer);
  }
}

export async function getPipedreamAccessToken(): Promise<string> {
  const creds = getPipedreamCreds();
  const key = cacheKey(creds);
  const now = Date.now();

  const cached = _cache.get(key);
  if (cached && cached.expiresAtMs - SKEW_MS > now) {
    return cached.token;
  }

  const existing = _inflight.get(key);
  if (existing) return existing;

  const p = mint(creds)
    .then(({ token, expiresInS }) => {
      _cache.set(key, { token, expiresAtMs: Date.now() + expiresInS * 1000 });
      return token;
    })
    .finally(() => {
      _inflight.delete(key);
    });
  _inflight.set(key, p);
  return p;
}

export function _clearPipedreamTokenCacheForTests(): void {
  _cache.clear();
  _inflight.clear();
}
