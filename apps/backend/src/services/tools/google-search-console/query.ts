import { z } from "zod";
import { searchAnalyticsQuery, type GscSearchAnalyticsBody } from "./_client";
import { customRangeSchema, dateRangeSchema, resolveRange } from "./_range";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({
  date_range: dateRangeSchema,
  custom_range: customRangeSchema.optional(),
  dimensions: z
    .array(z.enum(["query", "page", "country", "device", "date", "searchAppearance"]))
    .max(3)
    .default(["query"]),
  row_limit: z.number().int().min(1).max(1000).default(100),
});

export const gscQueryTool: ToolSpec = {
  name: "google_search_console_query",
  effect: "read",
  description:
    "Read organic search performance from the operator's connected Google Search Console property: clicks, impressions, CTR, and average position broken down by the requested dimensions (query, page, country, device, date) for the given date range. Read-only via the Search Console searchAnalytics.query API. Throws google_search_console_not_connected if OAuth is not yet wired.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { date_range, custom_range, dimensions, row_limit } = inputSchema.parse(input);
    const { startDate, endDate, label } = resolveRange(date_range, custom_range);

    const body: GscSearchAnalyticsBody = {
      startDate,
      endDate,
      dimensions,
      rowLimit: row_limit,
    };
    const report = await searchAnalyticsQuery(ctx.tenant_id, body);

    const rows = (report.rows ?? []).map((row) => ({
      keys: row.keys ?? [],
      clicks: row.clicks ?? 0,
      impressions: row.impressions ?? 0,
      ctr: row.ctr ?? 0,
      position: row.position ?? 0,
    }));

    return {
      date_range: label,
      dimensions,
      row_count: rows.length,
      rows,
    };
  },
};
