import { REDDIT_API_TOKEN_URL, redditApiCreds, redditApiUserAgent } from "./constants";

const EXPIRY_SKEW_MS = 60_000;
const FALLBACK_TTL_SEC = 3600;

let cached: { token: string; expiresAt: number } | null = null;
let inFlight: Promise<string> | null = null;

async function fetchAppToken(): Promise<{ token: string; ttlSec: number }> {
  const { id, secret } = redditApiCreds();
  const resp = await fetch(REDDIT_API_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "User-Agent": redditApiUserAgent(),
      Accept: "application/json",
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`Reddit app token HTTP ${resp.status}`);
  const json = (await resp.json()) as { access_token?: string; expires_in?: number; error?: string };
  if (json.error) throw new Error(`Reddit app token error: ${json.error}`);
  const token = json.access_token?.trim();
  if (!token) throw new Error("Reddit app token response missing access_token");
  const ttlSec = typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : FALLBACK_TTL_SEC;
  return { token, ttlSec };
}

export async function getRedditAppToken(now: () => number = Date.now): Promise<string> {
  if (cached && cached.expiresAt - EXPIRY_SKEW_MS > now()) return cached.token;
  if (!inFlight) {
    inFlight = fetchAppToken()
      .then(({ token, ttlSec }) => {
        cached = { token, expiresAt: now() + ttlSec * 1000 };
        return token;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

export function invalidateRedditAppToken(): void {
  cached = null;
}
