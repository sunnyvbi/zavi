
export const SNAPCHAT_ADS_SLUG = "snapchat_ads";
export const SNAPCHAT_ADS_ACCESS_TOKEN_KEY = `${SNAPCHAT_ADS_SLUG}.access_token`;
export const SNAPCHAT_ADS_REFRESH_TOKEN_KEY = `${SNAPCHAT_ADS_SLUG}.refresh_token`;

export const SNAPCHAT_ADS_API_BASE = "https://adsapi.snapchat.com/v1/";
export const SNAPCHAT_ADS_SCOPES = ["snapchat-marketing-api"] as const;
export const SNAPCHAT_ADS_DEFAULT_TTL_SEC = 1800;

export function snapchatAdsCreds(): { id: string; secret: string } {
  const id = process.env.SNAPCHAT_ADS_CLIENT_ID?.trim();
  const secret = process.env.SNAPCHAT_ADS_CLIENT_SECRET?.trim();
  if (!id || !secret) throw new Error("SNAPCHAT_ADS_CLIENT_ID and SNAPCHAT_ADS_CLIENT_SECRET must be set.");
  return { id, secret };
}
