
export type SettingsFieldRole =
  | "own_account"
  | "other_accounts"
  | "target"
  | "ceiling"
  | "floor"
  | "worth"
  | "destination"
  | "value";

export const SETTINGS_FIELD_ROLES: Record<string, SettingsFieldRole> = {
  "instagram_organic:handle": "own_account",
  "pinterest_organic:handle": "own_account",
  "linkedin_organic:profile_url": "own_account",
  "tiktok_organic:username": "own_account",
  "tiktok_ads:tiktok_handle": "own_account",
  "youtube_organic:handle": "own_account",

  "instagram_organic:competitors": "other_accounts",
  "pinterest_organic:competitors": "other_accounts",
  "linkedin_organic:targets": "other_accounts",
  "reddit_organic:competitors": "other_accounts",

  "chatgpt_ads:tcpa": "target",
  "google_ads:tcpa": "target",
  "linkedin_ads:deal_value": "worth",

  "chatgpt_ads:landing_page": "destination",
  "google_ads:landing_page": "destination",
  "linkedin_ads:landing_page": "destination",
  "reddit_ads:landing_page": "destination",
  "tiktok_ads:landing_page": "destination",
  "x_ads:landing_page": "destination",
  "tiktok_organic:destination": "destination",

  "google_ads:negatives": "value",
  "google_ads:maypause": "value",
  "email_marketing:segments": "value",
  "email_marketing:postal_address": "value",
  "meta_ads:metric_sources": "value",
  "reddit_organic:keywords": "value",
  "reddit_organic:communities": "value",
  "reddit_ads:comments_on": "value",
  "sms:number_route": "value",
  "sms:moments": "value",
  "tiktok_organic:on_camera": "value",
  "ugc:run_surface": "value",
  "ugc:claims_off_limits": "value",
  "youtube_organic:on_camera": "value",
  "youtube_organic:queries": "value",
};

export function settingsFieldRole(
  channelSlug: string,
  fieldId: string,
): SettingsFieldRole | null {
  return SETTINGS_FIELD_ROLES[`${channelSlug}:${fieldId}`] ?? null;
}

export type SettingsFieldUnit = "USD";

export const SETTINGS_FIELD_UNITS: Record<string, SettingsFieldUnit> = {
  "linkedin_ads:deal_value": "USD",
};

export function settingsFieldUnit(channelSlug: string, fieldId: string): SettingsFieldUnit | null {
  return SETTINGS_FIELD_UNITS[`${channelSlug}:${fieldId}`] ?? null;
}
