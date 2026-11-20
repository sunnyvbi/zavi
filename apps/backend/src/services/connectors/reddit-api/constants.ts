export const REDDIT_API_BASE = "https://oauth.reddit.com";
export const REDDIT_API_HOST = "oauth.reddit.com";
export const REDDIT_API_TOKEN_URL = "https://www.reddit.com/api/v1/access_token";

export function redditApiCreds(): { id: string; secret: string } {
  const id = process.env.REDDIT_API_CLIENT_ID?.trim();
  const secret = process.env.REDDIT_API_CLIENT_SECRET?.trim();
  if (!id || !secret) {
    throw new Error(
      "REDDIT_API_CLIENT_ID and REDDIT_API_CLIENT_SECRET must be set " +
        "(Zavi-owned Reddit app of type 'web app' at reddit.com/prefs/apps).",
    );
  }
  return { id, secret };
}

export function redditApiUserAgent(): string {
  const ua = process.env.REDDIT_API_USER_AGENT?.trim();
  if (!ua || !/^[a-z]+:[\w.-]+:v[\w.-]+ \(by \/u\/[\w-]+\)$/.test(ua)) {
    throw new Error(
      'REDDIT_API_USER_AGENT must look like "web:com.zaviagent.data:v1.0 (by /u/<zavi_account>)".',
    );
  }
  return ua;
}
