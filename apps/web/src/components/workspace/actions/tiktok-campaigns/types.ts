export const DYNAMIC_BUDGET_EXPLANATION = "TikTok may spend up to 25% more on a day, with weekly spending up to 7× the average daily budget (Sunday–Saturday). Changing the budget during the week adjusts this allowance.";
export const TIKTOK_CAMPAIGN_API = "/api/channels/tiktok_ads";

export type TiktokCampaignTarget = { advertiser_id: string; campaign_id: string };
export type TiktokLevel = "campaign" | "ad_group" | "ad";
export type TiktokSettings = {
  campaign_name?: string;
  adgroup_name?: string;
  ad_name?: string;
  location_ids?: string[];
  age_groups?: string[];
  gender?: string;
  languages?: string[];
  schedule_start_time?: string;
  schedule_end_time?: string;
  schedule_type?: string;
  ad_text?: string;
  landing_page_url?: string;
  call_to_action?: string;
  video_id?: string;
  objective_type?: string;
  ad_format?: string;
  aigc_disclosure_type?: "SELF_DISCLOSURE" | "NOT_DECLARED";
  placements?: string[];
  placement_type?: string;
  billing_event?: string;
  creative_material_mode?: string;
  campaign_automation_type?: string;
  budget_optimize_on?: boolean;
  special_industries?: string[];
  is_smart_performance_campaign?: boolean;
  is_aco?: boolean;
  dynamic_format?: string;
  dynamic_destination?: string;
  tiktok_item_id?: string;
  identity_authorized_bc_id?: string;
  image_ids?: string[];
  optimization_goal?: string;
  promotion_type?: string;
  identity_id?: string;
  identity_type?: string;
  auto_targeting_enabled?: boolean;
  smart_audience_enabled?: boolean;
  smart_interest_behavior_enabled?: boolean;
  audience_ids?: string[];
  excluded_audience_ids?: string[];
  interest_category_ids?: string[];
  operating_systems?: string[];
  network_types?: string[];
  dayparting?: string;
  comment_disabled?: boolean;
  share_disabled?: boolean;
  video_download_disabled?: boolean;
  bid_type?: string;
  bid_price?: number;
};
export type TiktokCampaignObject = {
  id: string;
  level: TiktokLevel;
  campaign_id: string;
  ad_group_id: string | null;
  name: string;
  status: string;
  secondary_status?: string | null;
  budget: number | null;
  budget_mode: string | null;
  revision: string;
  settings: TiktokSettings;
  limitations?: string[];
  editable_fields?: string[];
};
export type TiktokAdvertiser = { id: string; name: string; currency: string | null; timezone: string | null };
export type TiktokCampaignDetail = {
  advertiser: TiktokAdvertiser;
  campaign: TiktokCampaignObject;
  ad_groups: TiktokCampaignObject[];
  ads: TiktokCampaignObject[];
};
export type TiktokCampaignOptions = {
  advertiser: TiktokAdvertiser | null;
  identities: Array<{ identity_id: string; display_name: string | null }>;
  videos: Array<{ video_id: string; name: string; preview_url?: string | null }>;
  zavi_videos: Array<{ artifact_id: string; filename: string }>;
  locations: Array<{ location_id: string; name: string }>;
  languages: Array<{ id: string; name: string }>;
  blockers: Array<string | { code?: string; message?: string; what?: string; fix?: string }>;
  end_date_enabled: boolean;
  videos_truncated?: boolean;
  videos_next_page?: number | null;
  videos_error?: boolean;
  languages_error?: boolean;
  audiences?: Array<{ id: string; name: string }>;
  interests?: Array<{ id: string; name: string }>;
  audiences_error?: boolean;
  audiences_truncated?: boolean;
  interests_error?: boolean;
};
export const ADVANCED_GROUP_FIELDS = ["audience_ids", "excluded_audience_ids", "interest_category_ids", "operating_systems", "network_types", "dayparting", "comment_disabled", "share_disabled", "smart_audience_enabled", "smart_interest_behavior_enabled", "bid_type", "bid_price"] as const;
export const AGE_OPTIONS = [
  ["AGE_18_24", "18–24"], ["AGE_25_34", "25–34"], ["AGE_35_44", "35–44"],
  ["AGE_45_54", "45–54"], ["AGE_55_100", "55+"],
] as const;
export const CALLS_TO_ACTION = ["LEARN_MORE", "SHOP_NOW", "SIGN_UP", "CONTACT_US", "APPLY_NOW", "BOOK_NOW", "ORDER_NOW", "GET_QUOTE", "SUBSCRIBE"];
export const words = (value: string) => value.toLowerCase().replace(/_/g, " ").replace(/^./, c => c.toUpperCase());
export const dailyMode = (mode: string | null) => mode === "BUDGET_MODE_DAY" || mode === "BUDGET_MODE_DYNAMIC_DAILY_BUDGET";
export const utcInput = (iso?: string) => iso ? iso.replace(/Z$/, "").slice(0, 19) : "";
export const utcIso = (value: string) => value ? new Date(`${value}Z`).toISOString() : undefined;
export function videoSource(value: string): Record<string, string> {
  if (value.startsWith("url:")) return { video_url: value.slice(4) };
  if (value.startsWith("library:")) return { video_id: value.slice(8) };
  if (value.startsWith("zavi:")) return { video_artifact_id: value.slice(5) };
  if (value.startsWith("upload:")) return { video_upload_path: value.slice(7) };
  return {};
}
export function settingsDiff(before: TiktokSettings, after: TiktokSettings): TiktokSettings {
  return Object.fromEntries(Object.entries(after).filter(([key, value]) => value !== undefined && JSON.stringify(value) !== JSON.stringify(before[key as keyof TiktokSettings]))) as TiktokSettings;
}
