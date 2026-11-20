export function tiktokAdsErrorCode(code: number): string {
  if (code === 40102 || code === 40105) return "tiktok_ads_token_invalid";
  if (code === 40100 || code === 40133) return "tiktok_ads_rate_limited";
  return "tiktok_ads_error";
}
