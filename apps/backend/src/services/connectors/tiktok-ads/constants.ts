
export const TIKTOK_ADS_SLUG = "tiktok_ads";

export const TIKTOK_ADS_ACCESS_TOKEN_KEY = `${TIKTOK_ADS_SLUG}.access_token`;
export const TIKTOK_ADS_ADVERTISER_IDS_KEY = `${TIKTOK_ADS_SLUG}.advertiser_ids`;

export const TIKTOK_API_VERSION = "v1.3";
const PROD_BASE = "https://business-api.tiktok.com/open_api";
const SANDBOX_BASE = "https://sandbox-ads.tiktok.com/open_api";

export function tiktokAdsBaseUrl(): string {
  const sandbox = process.env.TIKTOK_ADS_SANDBOX === "1";
  return `${sandbox ? SANDBOX_BASE : PROD_BASE}/${TIKTOK_API_VERSION}`;
}

export function tiktokAdsCreds(): { appId: string; secret: string } {
  const appId = process.env.TIKTOK_ADS_APP_ID?.trim();
  const secret = process.env.TIKTOK_ADS_SECRET?.trim();
  if (!appId || !secret) {
    throw new Error(
      "TIKTOK_ADS_APP_ID and TIKTOK_ADS_SECRET must be set (TikTok Business API portal app).",
    );
  }
  return { appId, secret };
}

export function tiktokAdsEnabled(): boolean {
  return Boolean(process.env.TIKTOK_ADS_APP_ID?.trim() && process.env.TIKTOK_ADS_SECRET?.trim());
}

export const TIKTOK_CODE_HINTS: Record<number, string> = {
  40001: "Invalid parameter — check the advertiser_id and field names.",
  40100: "Rate limited at the APP level — back off and retry.",
  40102: "The access token expired or was revoked — reconnect TikTok Ads.",
  40105: "The access token is invalid — reconnect TikTok Ads.",
  40133: "Rate limited at the ADVERTISER level — back off and retry.",
};
