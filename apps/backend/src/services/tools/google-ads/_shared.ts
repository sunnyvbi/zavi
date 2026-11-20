import { z } from "zod";

export const GADS_DATE_RANGES = [
  "LAST_7_DAYS",
  "LAST_14_DAYS",
  "LAST_30_DAYS",
  "THIS_MONTH",
  "LAST_MONTH",
] as const;

export const dateRangeSchema = z.enum(GADS_DATE_RANGES);

export const customRangeSchema = z
  .object({
    since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .optional();

export function dateClause(
  date_range: (typeof GADS_DATE_RANGES)[number],
  custom_range?: { since: string; until: string },
): string {
  return custom_range
    ? `segments.date BETWEEN '${custom_range.since}' AND '${custom_range.until}'`
    : `segments.date DURING ${date_range}`;
}

export const CONVERSION_COLUMNS_NOTE =
  "`conversions` is Google's Conversions column: only actions set to Include in Conversions, the ones bidding optimises for. `all_conversions` counts every action, including excluded ones (signups, but also page views). Name the column a figure comes from. Waste is judged on `conversions`; all_conversions alone never clears a row unless the founder counts that action.";

export const GOOGLE_CONVERSION_FIELDS = ["conversions"] as const;
export const GOOGLE_OUTCOME_LABEL = "conversions the account bids on";
export const GOOGLE_SECONDARY_OUTCOME = {
  field: "all_conversions",
  label: "other actions (all_conversions)",
} as const;

export function numericIdOrThrow(label: string, id: string): string {
  if (!/^[0-9]+$/.test(id)) throw new Error(`invalid ${label}: ${id}`);
  return id;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function micros(v: string | undefined): number {
  return round2(Number(v ?? 0) / 1_000_000);
}

export type VideoMetricsRow = {
  costMicros?: string;
  impressions?: string;
  clicks?: string;
  conversions?: string;
  conversionsValue?: string;
  videoTrueviewViews?: string;
  videoTrueviewViewRate?: string;
  trueviewAverageCpv?: string;
  videoQuartileP25Rate?: string;
  videoQuartileP50Rate?: string;
  videoQuartileP75Rate?: string;
  videoQuartileP100Rate?: string;
  viewThroughConversions?: string;
  engagements?: string;
};

export const VIDEO_METRIC_FIELDS = [
  "metrics.cost_micros",
  "metrics.impressions",
  "metrics.clicks",
  "metrics.conversions",
  "metrics.conversions_value",
  "metrics.video_trueview_views",
  "metrics.video_trueview_view_rate",
  "metrics.trueview_average_cpv",
  "metrics.video_quartile_p25_rate",
  "metrics.video_quartile_p50_rate",
  "metrics.video_quartile_p75_rate",
  "metrics.video_quartile_p100_rate",
  "metrics.view_through_conversions",
  "metrics.engagements",
] as const;

export function mapVideoMetrics(m: VideoMetricsRow | undefined) {
  const cost = Number(m?.costMicros ?? 0) / 1_000_000;
  const views = Number(m?.videoTrueviewViews ?? 0);
  const conv = Number(m?.conversions ?? 0);
  const convValue = Number(m?.conversionsValue ?? 0);
  return {
    spend_usd: round2(cost),
    impressions: Number(m?.impressions ?? 0),
    clicks: Number(m?.clicks ?? 0),
    video_views: views,
    view_rate: m?.videoTrueviewViewRate == null ? null : round2(Number(m.videoTrueviewViewRate) * 100),
    avg_cpv_usd: m?.trueviewAverageCpv == null ? null : micros(m.trueviewAverageCpv),
    quartile_25_pct: pct(m?.videoQuartileP25Rate),
    quartile_50_pct: pct(m?.videoQuartileP50Rate),
    quartile_75_pct: pct(m?.videoQuartileP75Rate),
    quartile_100_pct: pct(m?.videoQuartileP100Rate),
    engagements: Number(m?.engagements ?? 0),
    conversions: round2(conv),
    view_through_conversions: round2(Number(m?.viewThroughConversions ?? 0)),
    conversions_value_usd: round2(convValue),
    roas: cost > 0 ? round2(convValue / cost) : null,
    cpa_usd: conv > 0 ? round2(cost / conv) : null,
  };
}

function pct(v: string | undefined): number | null {
  return v == null ? null : round2(Number(v) * 100);
}
