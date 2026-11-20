
export const LINKEDIN_ADS_SLUG = "linkedin_ads";
export const LINKEDIN_ADS_ACCESS_TOKEN_KEY = `${LINKEDIN_ADS_SLUG}.access_token`;
export const LINKEDIN_ADS_REFRESH_TOKEN_KEY = `${LINKEDIN_ADS_SLUG}.refresh_token`;

export const LINKEDIN_ADS_API_BASE = "https://api.linkedin.com/rest/";
export const LINKEDIN_API_VERSION = "202608";

export const LINKEDIN_ADS_SCOPES = ["r_ads", "r_ads_reporting", "rw_ads", "r_organization_social"] as const;
export const LINKEDIN_ADS_DEFAULT_TTL_SEC = 60 * 24 * 3600;

export function linkedinAdsCreds(): { id: string; secret: string } {
  const id = process.env.LINKEDIN_ADS_CLIENT_ID || process.env.LINKEDIN_SOCIAL_CLIENT_ID;
  const secret = process.env.LINKEDIN_ADS_CLIENT_SECRET || process.env.LINKEDIN_SOCIAL_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error(
      "LINKEDIN_ADS_CLIENT_ID/SECRET (or LINKEDIN_SOCIAL_CLIENT_ID/SECRET) must be set.",
    );
  }
  return { id, secret };
}

export const LINKEDIN_ADS_DAILY_LIMIT = "LinkedIn's daily allowance of requests for this LinkedIn connection is used up. It resets at 00:00 UTC (5:30 AM IST). Try again after that.";
