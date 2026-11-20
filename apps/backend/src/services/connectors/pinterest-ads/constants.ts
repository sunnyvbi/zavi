
export const PINTEREST_ADS_SLUG = "pinterest_ads";
export const PINTEREST_ADS_ACCESS_TOKEN_KEY = `${PINTEREST_ADS_SLUG}.access_token`;
export const PINTEREST_ADS_REFRESH_TOKEN_KEY = `${PINTEREST_ADS_SLUG}.refresh_token`;

export const PINTEREST_ADS_API_BASE = "https://api.pinterest.com/v5/";
export const PINTEREST_ADS_SCOPES = ["ads:read"] as const;
export const PINTEREST_ADS_DEFAULT_TTL_SEC = 30 * 24 * 3600;

export function pinterestAdsCreds(): { id: string; secret: string } {
  const id = process.env.PINTEREST_ADS_CLIENT_ID?.trim();
  const secret = process.env.PINTEREST_ADS_CLIENT_SECRET?.trim();
  if (!id || !secret) throw new Error("PINTEREST_ADS_CLIENT_ID and PINTEREST_ADS_CLIENT_SECRET must be set.");
  return { id, secret };
}
