import type {
  SuggestionCategory,
  SuggestionPriority,
  SuggestionSource,
  SuggestionStatus,
} from "@zavi/shared";
import type { Tone } from "./ui";

export type { SuggestionCategory, SuggestionPriority, SuggestionSource, SuggestionStatus };

export type EvidenceRef = {
  source: string;
  label: string;
  value: string;
  observed_at: string;
  window?: { since: string; until: string };
};

export type SourcePayload = {
  campaign_ids?: string[];
  sources?: string[];
  evidence?: EvidenceRef[];
  evidence_refs?: string[];
  metrics_snapshot?: Array<Record<string, unknown>>;
  time_range?: { since: string; until: string };
  prior_time_range?: { since: string; until: string };
  pixel_health?: { overall_status: string | null; pixels_found: number | null };
};

export type DuplicateWarning = {
  id: string;
  title: string;
  status: string;
};

export type GrowthSuggestion = {
  id: string;
  tenant_id: string;
  title: string;
  body: string;
  category: SuggestionCategory;
  priority: SuggestionPriority;
  status: SuggestionStatus;
  source: SuggestionSource;
  source_payload: SourcePayload;
  owner_staff_id: string | null;
  owner_staff_email: string | null;
  created_by_staff_id: string | null;
  created_by_staff_email: string | null;
  decision_id: string | null;
  duplicate_of: string | null;
  duplicate: DuplicateWarning | null;
  pushed_at: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
};

export type SuggestionSession = {
  id: string;
  tenant_id: string;
  title: string;
  created_at: string;
  last_message_at: string;
};

export const CATEGORY_LABEL: Record<SuggestionCategory, string> = {
  creative: "Creative",
  campaign: "Campaign",
  landing_page: "Landing page",
  budget: "Budget",
  other: "Other",
};

export const PRIORITY_LABEL: Record<SuggestionPriority, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

export const PRIORITY_TONE: Record<SuggestionPriority, Tone> = {
  high: "bad",
  medium: "warn",
  low: "flat",
};

export const SOURCE_LABEL: Record<SuggestionSource, string> = {
  ai_evidence: "AI · client evidence",
  ai_ads: "AI · ads (legacy)",
  manual: "Manual",
  paste: "Pasted",
};

const PROVIDER_LABEL: Record<string, string> = {
  meta_ads: "Meta Ads",
  google_ads: "Google Ads",
  ga4: "GA4",
  autopilot_goals: "Goals",
  competitor_intel_weekly: "Competitor scan",
  human_reviewed_profile: "Competitor profile",
  tenant_metric_snapshots: "KPI snapshots",
  model_assertion: "Unsourced",
};

export function providerLabel(source: string): string {
  return PROVIDER_LABEL[source] ?? source.replace(/_/g, " ");
}

export function suggestionProviders(suggestion: Pick<GrowthSuggestion, "source_payload">): string[] {
  const payload = suggestion.source_payload;
  if (payload.sources?.length) return payload.sources;
  const fromEvidence = (payload.evidence ?? [])
    .map((ref) => ref.source)
    .filter((source) => source && source !== "model_assertion");
  const withMeta = payload.campaign_ids?.length ? ["meta_ads", ...fromEvidence] : fromEvidence;
  return [...new Set(withMeta)];
}

export const STATUS_LABEL: Record<SuggestionStatus, string> = {
  draft: "Draft",
  awaiting_client: "Awaiting client",
  approved: "Accepted",
  archived: "Archived",
};

export const STATUS_TONE: Record<SuggestionStatus, Tone> = {
  draft: "flat",
  awaiting_client: "warn",
  approved: "good",
  archived: "flat",
};

function format(iso: string, render: (date: Date) => string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : render(date);
}

export function formatDay(iso: string): string {
  return format(iso, (date) => date.toLocaleDateString(undefined, { month: "short", day: "numeric" }));
}

export function formatTime(iso: string): string {
  return format(iso, (date) => date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
}
