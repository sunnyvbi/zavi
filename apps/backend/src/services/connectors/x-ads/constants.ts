
export const X_ADS_SLUG = "x_ads";
export const X_ADS_ACCESS_TOKEN_KEY = `${X_ADS_SLUG}.access_token`;
export const X_ADS_ACCESS_TOKEN_SECRET_KEY = `${X_ADS_SLUG}.access_token_secret`;
export const X_ADS_USER_ID_KEY = `${X_ADS_SLUG}.user_id`;
export const X_ADS_SCREEN_NAME_KEY = `${X_ADS_SLUG}.screen_name`;

export const X_ADS_API_BASE = "https://ads-api.x.com/12/";
export const X_OAUTH_REQUEST_TOKEN_URL = "https://api.x.com/oauth/request_token";
export const X_OAUTH_AUTHORIZE_URL = "https://api.x.com/oauth/authorize";
export const X_OAUTH_ACCESS_TOKEN_URL = "https://api.x.com/oauth/access_token";

export function xAdsConsumer(): { key: string; secret: string } {
  const key = process.env.X_ADS_CONSUMER_KEY?.trim();
  const secret = process.env.X_ADS_CONSUMER_SECRET?.trim();
  if (!key || !secret) {
    throw new Error("X_ADS_CONSUMER_KEY and X_ADS_CONSUMER_SECRET must be set (the app's OAuth 1.0a API Key/Secret).");
  }
  return { key, secret };
}

export function xAdsEnabled(): boolean {
  return Boolean(process.env.X_ADS_CONSUMER_KEY?.trim() && process.env.X_ADS_CONSUMER_SECRET?.trim());
}
