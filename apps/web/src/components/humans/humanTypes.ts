
import type { PackageFeeLine, SelfReportedMetrics } from "@zavi/shared";
export type VettingState = "pending" | "under_review" | "approved" | "rejected";

export type HumanPackage = {
  id: string;
  kind: string;
  title: string;
  description: string | null;
  delivery_days: number;
  video_count: number | null;
  video_length_seconds: number | null;
  ad_rights_days: number | null;
  addons: Array<{ code: string; price_cents: number } & PackageFeeLine>;
  fee: PackageFeeLine;
};

export type HumanApplication = {
  id: string;
  discipline: string;
  handle: string;
  platform: string;
  handles: Array<{ platform: string; handle: string }>;
  niches: string[];
  rate_usd: number | null;
  bio: string;
  portfolio_urls: string[];
  proof_count: number;
  vetting_state: VettingState;
  rejected_reason: string | null;
  submitted_at: string | null;
  reviewer_opened_at: string | null;
  queue_position: number | null;
  slug: string | null;
  lanes: string[];
  city: string | null;
  country_code: string | null;
  payout_country_supported: boolean | null;
  intro_video_path: string | null;
  sample_video_paths: string[];
  packages: HumanPackage[];
  audience: SelfReportedMetrics;
};

export type MediaUploadTicket = {
  path: string;
  token: string;
  signed_url: string;
  bucket: string;
  max_bytes: number;
  samples_max: number;
};

export type HumanApplicationResponse = {
  application: HumanApplication | null;
};

export type HumanBrief = {
  id: string;
  title: string;
  utm_campaign: string | null;
  status: string;
  deliverables: number | null;
  created_at: string;
  match_count: number | null;
  application_count: number | null;
  engagement_count: number | null;
  posted_at?: string | null;
  answer_by?: string | null;
  closed_at?: string | null;
  angle?: string | null;
  hook?: string | null;
  format?: string | null;
  lane?: string | null;
  budget_usd?: number | null;
  delivery_days?: number | null;
  applicant_cap?: number | null;
  ad_rights_days?: number | null;
  source_channel?: string | null;
};

export type HumanBriefsResponse = { briefs: HumanBrief[] };

export type HumanMatch = {
  member_id: string;
  handle: string;
  platform: string;
  discipline: string;
  skills: string[];
  rate_usd: number | null;
  rate_unit: string | null;
};

export type HumanApplicationSummary = {
  id: string;
  member_id: string;
  handle: string;
  platform: string;
  status: string;
  quoted_rate_usd: number | null;
  pitch: string;
  created_at: string;
  engagement_id: string | null;
};

export type HumanBriefDetailResponse = {
  brief: HumanBrief;
  matches: HumanMatch[];
  applications: HumanApplicationSummary[];
};

export type HumanEngagement = {
  id: string;
  brief_id: string;
  brief_title: string;
  member_handle: string;
  member_platform: string;
  status: string;
  agreed_rate_usd: number | null;
  created_at: string;
  utm_campaign: string | null;
};

export type HumanDeliverable = {
  id: string;
  label: string;
  status: string;
  asset_url: string | null;
};

export type HumanReceipt = {
  available: boolean;
  reason: string | null;
  spend_usd: number | null;
  attributed_revenue_usd: number | null;
  attributed_conversions: number | null;
};

export type HumanEngagementResponse = {
  engagement: HumanEngagement;
  deliverables: HumanDeliverable[];
  receipt: HumanReceipt;
};
