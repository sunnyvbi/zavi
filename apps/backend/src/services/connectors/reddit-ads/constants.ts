
export const REDDIT_ADS_SLUG = "reddit_ads";

export const REDDIT_ADS_ACCESS_TOKEN_KEY = `${REDDIT_ADS_SLUG}.access_token`;
export const REDDIT_ADS_REFRESH_TOKEN_KEY = `${REDDIT_ADS_SLUG}.refresh_token`;
export const REDDIT_ADS_USERNAME_KEY = `${REDDIT_ADS_SLUG}.username`;

export const REDDIT_ADS_ACCESS_TOKEN_TTL_SEC = 3600;

export const REDDIT_ADS_API_BASE = "https://ads-api.reddit.com/api/v3";

export const REDDIT_ADS_SCOPES = ["adsread"] as const;

export function redditAdsUserAgent(): string {
  return (
    process.env.REDDIT_ADS_USER_AGENT?.trim() ||
    "web:com.zaviagent.ads:v1.0 (by /u/DeveloperZavi)"
  );
}

export function redditAdsCreds(): { id: string; secret: string } {
  const id = process.env.REDDIT_ADS_CLIENT_ID || process.env.REDDIT_SOCIAL_CLIENT_ID;
  const secret =
    process.env.REDDIT_ADS_CLIENT_SECRET || process.env.REDDIT_SOCIAL_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error(
      "REDDIT_ADS_CLIENT_ID/SECRET (or REDDIT_SOCIAL_CLIENT_ID/SECRET) must be set " +
        "— a Reddit app of type 'web app' at reddit.com/prefs/apps.",
    );
  }
  return { id, secret };
}
