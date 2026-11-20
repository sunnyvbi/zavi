
export type CruxMetricKey =
  | "largest_contentful_paint"
  | "interaction_to_next_paint"
  | "cumulative_layout_shift"
  | "first_contentful_paint"
  | "experimental_time_to_first_byte";

export type CruxHistogramBin = { start?: number; end?: number; density?: number };

export type CruxMetric = { p75?: number; histogram?: CruxHistogramBin[] };

export type CruxDate = { year?: number; month?: number; day?: number };

export type SeoFieldReport =
  | {
      state: "ok";
      scope?: "url" | "origin";
      key?: string;
      collection_period?: { firstDate?: CruxDate; lastDate?: CruxDate };
      metrics?: Partial<Record<CruxMetricKey, CruxMetric | null>>;
    }
  | { state: "no_data"; tried?: string[] }
  | { state: "not_configured" }
  | { state: "unavailable"; reason?: string };

export type LabAudit = {
  id?: string;
  title?: string;
  score?: number | null;
  display_mode?: string;
};

export type LabCategory = {
  id?: string;
  title?: string;
  score?: number | null;
  display_mode?: string;
  audits?: LabAudit[];
};

export type PsiMetricSaving = {
  metric?: string;
  value?: number;
  unit?: "ms" | "score" | string;
};

export type PsiCulprit = {
  kind?: string;
  label?: string;
  detail?: string;
  owner?: "founder" | "developer" | string;
  bytes?: number | null;
  wastedBytes?: number | null;
};

export type LabOpportunity = {
  id?: string;
  title?: string | null;
  score?: number | null;
  metricSavings?: PsiMetricSaving[];
  savingsMs?: number | null;
  savingsBytes?: number | null;
  culprits?: PsiCulprit[];
};

export type LabPage = {
  requested_url?: string;
  final_url?: string;
  strategy?: string;
  lighthouse_version?: string;
  fetch_time?: string;
  categories?: LabCategory[];
  agentic_browsing?: LabCategory | null;
  opportunities?: LabOpportunity[];
};

export type AgentCheck = {
  id?: "llms_txt" | "ai_crawlers" | "server_rendered" | "layout_stable" | string;
  label?: string;
  state?: "pass" | "fail" | "unknown";
  detail?: string;
};

export type AgentReadiness = {
  checks?: AgentCheck[];
  passed?: number;
  disclosure?: string;
  applicable?: number;
};

export type SeoLabReport =
  | { state: "ok"; pages?: LabPage[]; truncated?: boolean }
  | { state: "not_configured" }
  | { state: "unavailable"; reason?: string };

export type DeliveryGap = {
  lab_ms?: number;
  field_ms?: number;
  field_scope?: "url" | "origin" | string;
  state?: "diverged" | "aligned" | string;
  note?: string;
} | null;

export type SeoPerformanceReport = {
  field?: SeoFieldReport | null;
  lab?: SeoLabReport | null;
  agent_readiness?: AgentReadiness | null;
  delivery_gap?: DeliveryGap;
  warming?: boolean;
  fetched_at?: string;
};

export type SeoFinding = {
  code: string;
  summary: string;
  urls: string[];
  severity?: "blocker" | "high" | "medium" | "low" | string;
  scope?: "site" | "partial" | string;
};

export type SeoPageFact = {
  url: string;
  status: number;
  title: string | null;
  title_length: number | null;
  meta_description: string | null;
  canonical: string | null;
  h1_count: number;
  schema_types: string[];
  noindex: boolean;
  visible_words: number;
  truncated?: boolean;
};

export type SeoSiteHealth = {
  status: "ok" | "error";
  site: string | null;
  error_code: string | null;
  fetched_at: string;
  stale: boolean;
  pages_analyzed: number;
  non_html_urls?: string[];
  findings: SeoFinding[];
  pages: SeoPageFact[];
  notes: string[];
};

export type SeoGeoLane = {
  status?: "ok" | "error" | string;
  score?: {
    total?: number;
    bands?: Array<{ key?: string; label?: string; note?: string; score?: number; weight?: number }>;
  };
  disclosure?: string;
};

export type SeoSitePublish = {
  pending: number;
  capped: boolean;
};

export type SeoChannelPayload = {
  generic?: boolean;
  connected?: boolean;
  site_health?: SeoSiteHealth | null;
  performance?: SeoPerformanceReport | null;
  geo?: SeoGeoLane | null;
  site_publish?: SeoSitePublish | null;
};
