
export const GOOGLE_ANALYTICS_VAULT_KEYS = {
  refresh_token: "google_analytics.refresh_token",
  property_id: "google_analytics.property_id",
} as const;

export const GOOGLE_ANALYTICS_REQUIRED_VAULT_KEYS = [
  GOOGLE_ANALYTICS_VAULT_KEYS.refresh_token,
  GOOGLE_ANALYTICS_VAULT_KEYS.property_id,
] as const;

export function googleAnalyticsClientId(): string | undefined {
  return process.env.GOOGLE_ANALYTICS_CLIENT_ID || process.env.GOOGLE_ADS_CLIENT_ID;
}
export function googleAnalyticsClientSecret(): string | undefined {
  return process.env.GOOGLE_ANALYTICS_CLIENT_SECRET || process.env.GOOGLE_ADS_CLIENT_SECRET;
}

export const GOOGLE_ANALYTICS_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
