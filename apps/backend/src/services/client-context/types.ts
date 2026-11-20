export type SectionStatus =
  | "ready"
  | "partial"
  | "not_configured"
  | "not_connected";

export type SourceAvailability = {
  source: string;
  status: SectionStatus;
  detail: string | null;
  last_seen_at: string | null;
};

export type EvidenceProvenance = "public" | "connected" | "model_assertion";

export type EvidenceRef = {
  source: string;
  label: string;
  value: string;
  observed_at: string;
  provenance: EvidenceProvenance;
  window?: { since: string; until: string };
};

export type Section<T> = {
  status: SectionStatus;
  detail: string | null;
  data: T;
  source_updated_at: string | null;
};

export type CompanyFact = {
  key: string;
  label: string;
  value: string;
  source: string;
  verified_at: string | null;
};

export type ProfileField = {
  key: string;
  label: string;
  value: string | null;
  source: string | null;
  observed_at: string | null;
  note?: string | null;
};

export type CompanySocialProfile = {
  platform: string;
  url: string | null;
  followers: string | null;
};

export type CompanySection = {
  tenant_id: string;
  name: string;
  slug: string;
  domain: string | null;
  facts: CompanyFact[];
  description: string | null;
  description_updated_at: string | null;
  connected_sources: string[];
  social_profiles: CompanySocialProfile[];
  profile: ProfileField[];
  icp: ProfileField[];
  business_model: ProfileField[];
  unrecorded_count: number;
};

export type GoalRow = {
  id: string;
  objective: string;
  target_metric: string;
  baseline_value: number | null;
  current_value: number | null;
  target_value: number;
  progress: number | null;
  due_date: string | null;
  status: string;
  priority: number;
  updated_at: string;
};

export type GoalsSection = {
  goals: GoalRow[];
  summary: {
    active: number;
    on_track: number;
    needs_attention: number;
    average_progress: number | null;
  };
};

export type ChannelRow = {
  channel: string;
  kind: "paid" | "organic";
  source: string;
  spend_usd: number | null;
  impressions: number | null;
  clicks: number | null;
  leads: number | null;
  customers: number | null;
  revenue_usd: number | null;
  cac_usd: number | null;
  roas: number | null;
  conversion_rate: number | null;
};

export type PaidChannelRow = ChannelRow & {
  id: string;
  campaign_id: string;
  campaign_name: string | null;
  ads_count: number | null;
  status: string | null;
  reach: number | null;
  result: number | null;
  cost_result_usd: number | null;
  budget_usd: number | null;
  budget_period: "daily" | "lifetime" | null;
  website_purchases: number | null;
  website_registrations: number | null;
  ctr: number | null;
  cpc_usd: number | null;
  cpm_usd: number | null;
  schedule_at: string | null;
  ends_at: string | null;
};

export type ChannelsSection = {
  paid: PaidChannelRow[];
  organic: ChannelRow[];
  totals: {
    paid: ChannelRow | null;
    organic: ChannelRow | null;
  };
  window: { since: string; until: string };
};

export type MetricRow = {
  key: string;
  label: string;
  value: number | null;
  unit: "count" | "usd" | "ratio";
  direction: "up" | "down" | "context";
  source: string;
  window_kind: string;
  window_end: string;
  previous_value: number | null;
  change: number | null;
};

export type AnalyticsSection = {
  metrics: MetricRow[];
  trends: {
    points: Array<{
      date: string;
      spend_usd: number | null;
      revenue_usd: number | null;
      leads: number | null;
      customers: number | null;
      sessions: number | null;
      cac_usd: number | null;
      roas: number | null;
      conversion_rate: number | null;
    }>;
    channel_points: Array<{ date: string; by_channel: Record<string, number> }>;
    sources: string[];
    window: { since: string; until: string };
  };
  channels: ChannelsSection | null;
};

export type CompetitorRow = {
  name: string;
  website: string | null;
  category?: string | null;
  positioning: string | null;
  audience: string | null;
  pricing: string | null;
  channels: string[];
  strengths: string[];
  weaknesses: string[];
  threat_level: string | null;
  source: string;
  observed_at: string | null;
};

export type CompetitorsSection = {
  competitors: CompetitorRow[];
  recommended_moves: Array<{ title: string; rationale: string | null }>;
  week_bucket: string | null;
};

export type ClientContext = {
  tenant_id: string;
  generated_at: string;
  company: Section<CompanySection>;
  goals: Section<GoalsSection>;
  channels: Section<ChannelsSection>;
  analytics: Section<AnalyticsSection>;
  competitors: Section<CompetitorsSection>;
  availability: SourceAvailability[];
  source_timestamps: Record<string, string | null>;
};
