
import { z } from "zod";
import {
  googleSearchConsoleCreds,
  searchAnalyticsQuery,
  type GscDimensionFilter,
  type GscSearchAnalyticsResponse,
} from "./_client";
import { customRangeSchema, dateRangeSchema, resolveRange } from "./_range";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({
  page_url: z.string().url(),
  match: z.enum(["exact", "contains"]).default("exact"),
  date_range: dateRangeSchema,
  custom_range: customRangeSchema.optional(),
  query_limit: z.number().int().min(1).max(500).default(25),
});

type Row = { keys: string[]; clicks: number; impressions: number; ctr: number; position: number };

function mapRows(r: GscSearchAnalyticsResponse): Row[] {
  return (r.rows ?? []).map((row) => ({
    keys: row.keys ?? [],
    clicks: row.clicks ?? 0,
    impressions: row.impressions ?? 0,
    ctr: row.ctr ?? 0,
    position: row.position ?? 0,
  }));
}

function firstKeyRows(r: GscSearchAnalyticsResponse): Array<Omit<Row, "keys"> & { key: string }> {
  return mapRows(r).map(({ keys, ...m }) => ({ key: keys[0] ?? "", ...m }));
}

export const gscPagePerformanceTool: ToolSpec = {
  name: "google_search_console_page_performance",
  effect: "read",
  description:
    "Search Console performance for ONE page: total clicks, impressions, CTR and average position for that URL, plus the queries it actually ranks for and its device split. Server-side filtered to the URL, so it works for pages far outside the site's top 1,000 rows. Use this for a single-page SEO review instead of scanning google_search_console__query output. Read-only. Throws google_search_console_not_connected if OAuth is not wired.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { page_url, match, date_range, custom_range, query_limit } = inputSchema.parse(input);
    const { startDate, endDate, label } = resolveRange(date_range, custom_range);

    const filter: GscDimensionFilter = {
      dimension: "page",
      operator: match === "exact" ? "equals" : "contains",
      expression: page_url,
    };
    const scope = { dimensionFilterGroups: [{ groupType: "and" as const, filters: [filter] }] };

    const creds = await googleSearchConsoleCreds(ctx.tenant_id);
    const [totalsRes, queriesRes, deviceRes] = await Promise.all([
      searchAnalyticsQuery(ctx.tenant_id, { startDate, endDate, ...scope, rowLimit: 1 }, creds),
      searchAnalyticsQuery(
        ctx.tenant_id,
        { startDate, endDate, dimensions: ["query"], rowLimit: query_limit, ...scope },
        creds,
      ),
      searchAnalyticsQuery(ctx.tenant_id, { startDate, endDate, dimensions: ["device"], rowLimit: 10, ...scope }, creds),
    ]);

    const total = mapRows(totalsRes)[0];
    const queries = firstKeyRows(queriesRes);

    return {
      page_url,
      match,
      site_url: creds.site_url,
      date_range: label,
      has_data: Boolean(total),
      totals: total
        ? { clicks: total.clicks, impressions: total.impressions, ctr: total.ctr, position: total.position }
        : { clicks: 0, impressions: 0, ctr: 0, position: 0 },
      top_queries: queries,
      query_count: queries.length,
      queries_truncated: queries.length >= query_limit,
      by_device: firstKeyRows(deviceRes),
    };
  },
};
