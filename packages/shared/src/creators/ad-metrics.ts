
export const CREATOR_AD_METRICS_MIN_CONVERSIONS = 50;

export const CREATOR_AD_METRIC_FIELDS = [
  "spend_usd",
  "impressions",
  "clicks",
  "reach",
  "conversions",
  "purchases",
  "purchase_value_usd",
] as const;

export type CreatorAdMetricField = (typeof CREATOR_AD_METRIC_FIELDS)[number];

export type CreatorAdMetrics = Record<CreatorAdMetricField, number>;

export type CreatorAdEvidence = {
  enough_evidence: boolean;
  conversions: number;
  needed_conversions: number;
  progress_label: string | null;
};

export function creatorAdEvidence(conversions: number): CreatorAdEvidence {
  const c = Number.isFinite(conversions) && conversions > 0 ? Math.floor(conversions) : 0;
  return {
    enough_evidence: c >= CREATOR_AD_METRICS_MIN_CONVERSIONS,
    conversions: c,
    needed_conversions: CREATOR_AD_METRICS_MIN_CONVERSIONS,
    progress_label:
      c >= CREATOR_AD_METRICS_MIN_CONVERSIONS
        ? null
        : `${c} of ${CREATOR_AD_METRICS_MIN_CONVERSIONS} conversions`,
  };
}

export const CREATOR_AD_METRICS_ABSTAIN_TITLE = "Not enough evidence yet";

export const CREATOR_AD_METRICS_ABSTAIN_BODY =
  "Zavi shows this ad's own numbers once it has recorded enough conversions to be worth reading. Until then the totals move on luck.";

export const CREATOR_AD_METRICS_SCOPE_NOTE =
  "This ad's own totals from your Meta ad account, for the window since the rights started. Your targeting, budget and schedule produced them.";
