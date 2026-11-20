import { ExpectedToolError } from "@/services/tools/types";
import { getRedditAppToken, invalidateRedditAppToken } from "./app-token";
import { REDDIT_API_BASE, REDDIT_API_HOST, redditApiUserAgent } from "./constants";

const TIMEOUT_MS = 20_000;
const MAX_WAIT_MS = 60_000;
const MAX_ATTEMPTS = 3;

export type RedditRateLimitState = {
  used: number | null;
  remaining: number | null;
  resetAt: number | null;
  observedAt: number | null;
};

let rate: RedditRateLimitState = { used: null, remaining: null, resetAt: null, observedAt: null };

export function getRedditRateLimitState(): RedditRateLimitState {
  return { ...rate };
}

export function resetRedditRateLimitStateForTests(): void {
  rate = { used: null, remaining: null, resetAt: null, observedAt: null };
}

function num(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function recordRateHeaders(headers: Headers, now: number): void {
  const used = num(headers.get("x-ratelimit-used"));
  const remaining = num(headers.get("x-ratelimit-remaining"));
  const reset = num(headers.get("x-ratelimit-reset"));
  if (used === null && remaining === null && reset === null) return;
  rate = {
    used,
    remaining,
    resetAt: reset === null ? null : now + reset * 1000,
    observedAt: now,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForBudget(now: () => number): Promise<void> {
  if (rate.remaining === null || rate.remaining >= 1 || rate.resetAt === null) return;
  const waitMs = rate.resetAt - now();
  if (waitMs <= 0) return;
  if (waitMs > MAX_WAIT_MS) {
    throw new ExpectedToolError(
      "reddit_api_rate_limited",
      `Reddit API rate limit spent; window resets in ${Math.ceil(waitMs / 1000)}s.`,
    );
  }
  await sleep(waitMs);
}

export async function redditApiGet<T>(
  path: string,
  query: Record<string, string | number | boolean | undefined> = {},
  deps: { now?: () => number } = {},
): Promise<T> {
  const now = deps.now ?? Date.now;
  if (!path.startsWith("/") || path.includes("//") || path.includes("://")) {
    throw new Error(`redditApiGet: invalid path ${JSON.stringify(path)}`);
  }
  const url = new URL(path, REDDIT_API_BASE);
  if (url.host !== REDDIT_API_HOST) throw new Error("redditApiGet: host escape");
  url.searchParams.set("raw_json", "1");
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await waitForBudget(now);
    const token = await getRedditAppToken(now);
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": redditApiUserAgent(),
        Accept: "application/json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    recordRateHeaders(resp.headers, now());

    if (resp.ok) {
      try {
        return (await resp.json()) as T;
      } catch {
        throw new ExpectedToolError("reddit_api_bad_response", "Reddit API returned non-JSON.");
      }
    }
    if (resp.status === 401 && attempt < MAX_ATTEMPTS) {
      invalidateRedditAppToken();
      continue;
    }
    if ((resp.status === 429 || resp.status >= 500) && attempt < MAX_ATTEMPTS) {
      const resetMs = rate.resetAt ? rate.resetAt - now() : 0;
      const backoffMs = Math.min(MAX_WAIT_MS, Math.max(resetMs, 1000 * 2 ** attempt));
      await sleep(backoffMs);
      continue;
    }
    if (resp.status === 403 || resp.status === 404) {
      throw new ExpectedToolError(
        "reddit_api_not_available",
        `Reddit returned HTTP ${resp.status} for ${url.pathname}.`,
      );
    }
    throw new ExpectedToolError(
      resp.status === 429 ? "reddit_api_rate_limited" : "reddit_api_http_error",
      `Reddit API HTTP ${resp.status} for ${url.pathname}.`,
    );
  }
  throw new ExpectedToolError("reddit_api_http_error", `Reddit API gave up on ${url.pathname}.`);
}
