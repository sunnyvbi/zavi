import { z } from "zod";
import { createGoogleAdsReadSession } from "./_client";
import { accountClock, shiftDate } from "./_read-window";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({ campaign_id: z.string().regex(/^\d+$/), lookback_days: z.number().int().min(30).max(180).default(90) });
const MAX_UNKNOWN_SHARE = 0.05;
const bucketDays: Record<string, number> = {
  LESS_THAN_ONE_DAY: 1, ONE_TO_TWO_DAYS: 2, TWO_TO_THREE_DAYS: 3, THREE_TO_FOUR_DAYS: 4,
  FOUR_TO_FIVE_DAYS: 5, FIVE_TO_SIX_DAYS: 6, SIX_TO_SEVEN_DAYS: 7, SEVEN_TO_EIGHT_DAYS: 8,
  EIGHT_TO_NINE_DAYS: 9, NINE_TO_TEN_DAYS: 10, TEN_TO_ELEVEN_DAYS: 11, ELEVEN_TO_TWELVE_DAYS: 12,
  TWELVE_TO_THIRTEEN_DAYS: 13, THIRTEEN_TO_FOURTEEN_DAYS: 14, FOURTEEN_TO_TWENTY_ONE_DAYS: 21,
  TWENTY_ONE_TO_THIRTY_DAYS: 30, THIRTY_TO_FORTY_FIVE_DAYS: 45, FORTY_FIVE_TO_SIXTY_DAYS: 60, SIXTY_TO_NINETY_DAYS: 90,
};
type LagRow = { segments?: { conversionLagBucket?: string }; metrics?: { conversions?: string | number } };

export function summarizeLag(rows: LagRow[]) {
  const counts = new Map<string, number>();
  let invalid = false;
  for (const row of rows) {
    const bucket = row.segments?.conversionLagBucket ?? "UNSPECIFIED";
    const raw = row.metrics?.conversions;
    const count = raw == null ? NaN : Number(raw);
    if (!Number.isFinite(count) || count < 0) { invalid = true; continue; }
    counts.set(bucket, (counts.get(bucket) ?? 0) + count);
  }
  const buckets = [...counts].map(([bucket, conversions]) => ({ bucket, upper_bound_days: Object.hasOwn(bucketDays, bucket) ? bucketDays[bucket] : null, conversions })).sort((a, b) => (a.upper_bound_days ?? Infinity) - (b.upper_bound_days ?? Infinity) || a.bucket.localeCompare(b.bucket));
  const total = buckets.reduce((sum, row) => sum + row.conversions, 0);
  const unknown = buckets.filter((row) => row.upper_bound_days === null).reduce((sum, row) => sum + row.conversions, 0);
  const unknownShare = total > 0 ? unknown / total : null;
  const known = total - unknown;
  let cumulative = 0;
  const percentile = buckets.filter((row) => row.upper_bound_days !== null).find((row) => { cumulative += row.conversions; return cumulative >= known * 0.9; });
  const l90 = known > 0 && unknownShare !== null && unknownShare < MAX_UNKNOWN_SHARE && !invalid ? percentile?.upper_bound_days ?? null : null;
  return { buckets, observed_conversions: total, unknown_bucket_conversions: unknown, unknown_bucket_share: unknownShare, unknown_share_limit: MAX_UNKNOWN_SHARE, estimated_from_known_buckets: unknown > 0 && l90 !== null, invalid_metrics: invalid, l90_days: l90 };
}

export const conversionLagTool: ToolSpec = {
  name: "google_ads_conversion_lag",
  effect: "read",
  description: "Estimate campaign L90 from v25 conversion_lag_bucket and fractional metrics.conversions. Uses an account-local historical interaction cohort ending 91 days ago to reduce right-censoring. Returns the upper bound of the bucket reaching 90% of conversions in known buckets. Unknown mass below 5% is excluded and disclosed; at 5% or more, or for empty, invalid or capped data, L90 is null. This historical estimate may not represent new campaigns or changed goals.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { campaign_id, lookback_days } = inputSchema.parse(input);
    const search = createGoogleAdsReadSession(ctx.tenant_id);
    const clock = await accountClock(ctx.tenant_id, search);
    const end = shiftDate(clock.date, -91);
    const start = shiftDate(end, 1 - lookback_days);
    const rows = await search(`SELECT segments.conversion_lag_bucket, metrics.conversions FROM campaign WHERE campaign.id = ${campaign_id} AND segments.date BETWEEN '${start}' AND '${end}' LIMIT 1000`) as LagRow[];
    const summary = summarizeLag(rows);
    const truncated = rows.length >= 1000;
    return {
      connected: true, campaign_id, time_zone: clock.time_zone, window: { start, end },
      ...summary, l90_days: truncated ? null : summary.l90_days, estimated_from_known_buckets: !truncated && summary.estimated_from_known_buckets, possibly_truncated: truncated,
      basis: "Historical interaction-date cohort; metrics.conversions only; 90th percentile bucket upper bound in days.",
      limitation: "Bucket bounds are estimates, not exact percentiles. Excluding the latest 90 full days reduces right-censoring but makes the estimate historical. Goal, strategy, audience or conversion-delay changes can invalidate transfer to current work. Empty data is not zero lag; Unknown mass below 5% is excluded from percentile arithmetic and the estimate is labelled; at 5% or more it is suppressed. Negative or missing metrics still suppress L90. No universal confidence/sample floor is assumed.",
    };
  },
};
