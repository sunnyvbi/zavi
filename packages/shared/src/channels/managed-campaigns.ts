export type CampaignMetrics = Partial<Record<"impressions" | "clicks" | "spend" | "ctr" | "cpc" | "cpm" | "conversions" | "click_through_conversions" | "view_through_conversions", number>>;
export type ManagedCampaign = CampaignMetrics & {
  id: string;
  name: string;
  status: string | null;
  updated_at?: number;
  bidding_type?: string;
  budget?: { lifetime_spend_limit_micros?: number; daily_spend_limit_micros?: number };
  created_at?: number;
  conversion_event_setting_ids?: string[];
  targeting?: CampaignTargeting;
  mode?: string | null;
  product_feed_id?: string;
  landing_page_configuration?: { query_string_template: string };
  start_time?: number | null;
  end_time?: number | null;
  period_unconfirmed?: boolean;
};
export type ManagedAdEntity = CampaignMetrics & {
  id: string;
  name: string;
  status: string | null;
  campaign_id: string;
  ad_group_id?: string;
  parent_name: string;
  metrics_unavailable?: boolean;
  review_status?: string;
  serving_issues?: string[];
  landing_page_configuration?: { query_string_template: string };
  bidding_config?: { strategy?: string; billing_event_type?: string; max_bid_micros?: number };
  context_hints?: string[];
  creative?: { type?: string; title?: string; body?: string; target_url?: string; image_url?: string; file_id?: string };
};
export type ManagedCampaignDashboard = {
  source: string;
  conversion_tracking?: "configured" | "not_configured" | "unavailable";
  account_read?: { status: "complete" | "partial" | "unavailable"; observed_at: string };
  campaigns: ManagedCampaign[];
  draft?: CampaignDraft;
  setup_notice?: string;
  totals_across_your_campaigns_only: CampaignMetrics;
  currency: string | null;
  period: { from: string; to: string; days: number; timezone?: string } | null;
  campaign_name_prefix?: string;
  no_campaigns_for_tenant?: boolean;
  error_code?: string;
  warning?: string;
  purchase_return?: { roas: number | null; from: string; to: string; days: number; timezone: string };
};

export type CampaignDraft = {
  type: "campaign_draft";
  name: string;
  bidding_type: "clicks" | "impressions" | "conversions";
  conversion_event_setting_ids?: string[];
  group: { name: string; context_hints: string[] };
  ads: Array<{ name: string; title: string; body: string; target_url: string; image_url?: string; image_spec?: string; tracking: string }>;
};

export type CampaignLocation = {
  id: string;
  name?: string;
  type?: string;
  country_code?: string;
  region_code?: string;
  parent_country?: string;
};

export function campaignLocationDetail(place: CampaignLocation): string {
  return [place.type?.replace(/_/g, " "), place.region_code, place.parent_country || place.country_code].filter(Boolean).join(" · ");
}

export type CampaignTargeting = {
  locations?: { countries?: string[]; include?: CampaignLocation[] };
  excluded_locations?: { countries?: string[]; include?: CampaignLocation[] };
  platforms?: { included: string[] };
  custom_audiences?: { ids: string[] };
  excluded_custom_audiences?: { ids: string[] };
};
export type CampaignResourceOptions = {
  conversion_events: Array<{ id: string; name: string }>;
  inclusion_audiences: Array<{ id: string; name: string }>;
  exclusion_audiences: Array<{ id: string; name: string }>;
  product_feeds: Array<{ id: string; name: string }>;
  warnings: string[];
};

export * from "./ad-approval";
