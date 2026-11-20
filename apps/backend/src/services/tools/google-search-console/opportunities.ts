
import { z } from "zod";
import { searchAnalyticsQuery } from "./_client";
import { customRangeSchema, dateRangeSchema, resolveRange } from "./_range";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({
  dimension: z.enum(["query", "page"]).default("query"),
  date_range: dateRangeSchema,
  custom_range: customRangeSchema.optional(),
  min_impressions: z.number().int().min(1).max(100_000).default(50),
  striking_distance: z
    .object({ min_position: z.number().min(1).max(100), max_position: z.number().min(1).max(100) })
    .default({ min_position: 4, max_position: 20 }),
  limit: z.number().int().min(1).max(100).default(25),
});

type Row = { key: string; clicks: number; impressions: number; ctr: number; position: number };

function positionBucket(position: number): number {
  return Math.max(1, Math.round(position));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

const MIN_BENCHMARK_SAMPLE = 5;
const LOW_CTR_RATIO = 0.5;

export const gscOpportunitiesTool: ToolSpec = {
  name: "google_search_console_opportunities",
  effect: "read",
  description:
    "Rank the cheapest organic wins in the connected Search Console property, from real data. Returns three lists, each row carrying its own clicks/impressions/CTR/position: striking_distance (already ranking 4-20 with real impressions — a rank push, not new content), low_ctr_for_position (ranking well but under-clicked versus this property's OWN median CTR at the same position, i.e. a title/meta problem, not a ranking problem), and high_impressions_no_clicks. Group by query or page. Read-only. Throws google_search_console_not_connected if OAuth is not wired.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { dimension, date_range, custom_range, min_impressions, striking_distance, limit } =
      inputSchema.parse(input);
    const { startDate, endDate, label } = resolveRange(date_range, custom_range);

    const res = await searchAnalyticsQuery(ctx.tenant_id, {
      startDate,
      endDate,
      dimensions: [dimension],
      rowLimit: 1000,
    });

    const all: Row[] = (res.rows ?? []).map((r) => ({
      key: r.keys?.[0] ?? "",
      clicks: r.clicks ?? 0,
      impressions: r.impressions ?? 0,
      ctr: r.ctr ?? 0,
      position: r.position ?? 0,
    }));
    const eligible = all.filter((r) => r.impressions >= min_impressions);

    const byBucket = new Map<number, number[]>();
    for (const r of eligible) {
      const b = positionBucket(r.position);
      const list = byBucket.get(b);
      if (list) list.push(r.ctr);
      else byBucket.set(b, [r.ctr]);
    }
    const benchmarks = new Map<number, { median_ctr: number; n: number }>();
    for (const [bucket, ctrs] of byBucket) {
      benchmarks.set(bucket, { median_ctr: median(ctrs), n: ctrs.length });
    }

    const striking = eligible
      .filter(
        (r) => r.position >= striking_distance.min_position && r.position <= striking_distance.max_position,
      )
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, limit);

    const lowCtr = eligible
      .map((r) => {
        const bm = benchmarks.get(positionBucket(r.position));
        if (!bm || bm.n < MIN_BENCHMARK_SAMPLE || bm.median_ctr <= 0) return null;
        if (r.ctr >= bm.median_ctr * LOW_CTR_RATIO) return null;
        return {
          ...r,
          position_bucket: positionBucket(r.position),
          benchmark_ctr: bm.median_ctr,
          benchmark_sample_size: bm.n,
          ctr_vs_benchmark: bm.median_ctr > 0 ? r.ctr / bm.median_ctr : 0,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => b.impressions * (b.benchmark_ctr - b.ctr) - a.impressions * (a.benchmark_ctr - a.ctr))
      .slice(0, limit);

    const zeroClicks = eligible
      .filter((r) => r.clicks === 0)
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, limit);

    return {
      dimension,
      date_range: label,
      rows_scanned: all.length,
      rows_eligible: eligible.length,
      truncated_at_api_limit: all.length >= 1000,
      min_impressions,
      striking_distance: { criteria: striking_distance, count: striking.length, rows: striking },
      low_ctr_for_position: {
        method:
          "CTR below half this property's own median CTR among rows at the same rounded position, requiring at least 5 rows in that bucket. Not an external CTR curve.",
        count: lowCtr.length,
        rows: lowCtr,
      },
      high_impressions_no_clicks: { count: zeroClicks.length, rows: zeroClicks },
    };
  },
};
