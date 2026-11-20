
export const GOOGLE_ADS_VAULT_KEYS = {
  refresh_token: "google_ads.refresh_token",
  customer_id: "google_ads.customer_id",
  login_customer_id: "google_ads.login_customer_id",
} as const;

export const GOOGLE_ADS_REQUIRED_VAULT_KEYS = [
  GOOGLE_ADS_VAULT_KEYS.refresh_token,
  GOOGLE_ADS_VAULT_KEYS.customer_id,
] as const;

export const GOOGLE_ADS_ENV_KEYS = {
  client_id: "GOOGLE_ADS_CLIENT_ID",
  client_secret: "GOOGLE_ADS_CLIENT_SECRET",
  developer_token: "GOOGLE_ADS_DEVELOPER_TOKEN",
} as const;

export const GOOGLE_ADS_API_VERSION = "v25";
export const GOOGLE_ADS_API_BASE = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`;
