
import { ExpectedToolError } from "@/services/tools/types";
import { REDDIT_ADS_API_BASE, redditAdsUserAgent } from "./constants";

const TIMEOUT_MS = 20_000;

export type RedditEnvelope<T> = {
  data: T;
  pagination?: { next_url?: string };
};

export type RedditBusiness = { id: string; name?: string };

export async function redditAdsGet<T>(
  accessToken: string,
  url: string,
): Promise<RedditEnvelope<T>> {
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": redditAdsUserAgent(),
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new ExpectedToolError(
      resp.status === 401 || resp.status === 403
        ? "reddit_ads_forbidden"
        : "reddit_ads_http_error",
      `Reddit Ads API HTTP ${resp.status}. ${
        resp.status === 403
          ? "The connected Reddit account has no access to this ads resource."
          : "Reconnect Reddit Ads if this persists."
      }`,
    );
  }
  try {
    return JSON.parse(text) as RedditEnvelope<T>;
  } catch {
    throw new ExpectedToolError(
      "reddit_ads_bad_response",
      "Reddit Ads API returned non-JSON.",
    );
  }
}

export async function listRedditBusinesses(accessToken: string): Promise<RedditBusiness[]> {
  const env = await redditAdsGet<RedditBusiness[]>(
    accessToken,
    `${REDDIT_ADS_API_BASE}/me/businesses?page.size=100`,
  );
  return Array.isArray(env.data) ? env.data : [];
}
