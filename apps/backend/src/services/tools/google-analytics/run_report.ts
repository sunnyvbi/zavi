
import { z } from "zod";
import { runReport, type GaRunReportBody } from "./_client";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({
  date_range: z
    .enum(["LAST_7_DAYS", "LAST_14_DAYS", "LAST_28_DAYS", "LAST_30_DAYS", "LAST_90_DAYS"])
    .default("LAST_28_DAYS"),
  custom_range: z
    .object({
      since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .optional(),
});

export const GA_ROW_LIMIT = 10000;

const RANGE_TO_START: Record<string, string> = {
  LAST_7_DAYS: "7daysAgo",
  LAST_14_DAYS: "14daysAgo",
  LAST_28_DAYS: "28daysAgo",
  LAST_30_DAYS: "30daysAgo",
  LAST_90_DAYS: "90daysAgo",
};

type AttributionRow = {
  source: string;
  medium: string;
  campaign: string;
  sessions: number;
  users: number;
  conversions: number;
  revenue: number;
};

export const gaRunReportTool: ToolSpec = {
  name: "google_analytics_run_report",
  effect: "read",
  description:
    "Read GA4 attribution from the operator's connected Google Analytics property: sessions, users, conversions (GA4 key events), and revenue broken down by source / medium / campaign for the given date range. `totals` is GA4's own total across every row: use it for sums, never add up `rows` (`truncated` says rows were cut). Read-only via the GA4 Data API. Throws google_analytics_not_connected if OAuth is not yet wired.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { date_range, custom_range } = inputSchema.parse(input);
    const startDate = custom_range ? custom_range.since : (RANGE_TO_START[date_range] ?? "28daysAgo");
    const endDate = custom_range ? custom_range.until : "yesterday";

    const body: GaRunReportBody = {
      dateRanges: [{ startDate, endDate }],
      dimensions: [
        { name: "sessionSource" },
        { name: "sessionMedium" },
        { name: "sessionCampaignName" },
      ],
      metrics: [
        { name: "sessions" },
        { name: "totalUsers" },
        { name: "keyEvents" },
        { name: "purchaseRevenue" },
      ],
      limit: String(GA_ROW_LIMIT),
      metricAggregations: ["TOTAL"],
    };

    const report = await runReport(ctx.tenant_id, body);

    const num = (v?: string): number => {
      const n = Number(v ?? "0");
      return Number.isFinite(n) ? n : 0;
    };
    const rows: AttributionRow[] = (report.rows ?? []).map((row) => {
      const d = row.dimensionValues ?? [];
      const m = row.metricValues ?? [];
      return {
        source: d[0]?.value ?? "(not set)",
        medium: d[1]?.value ?? "(not set)",
        campaign: d[2]?.value ?? "(not set)",
        sessions: num(m[0]?.value),
        users: num(m[1]?.value),
        conversions: num(m[2]?.value),
        revenue: num(m[3]?.value),
      };
    });

    const rowCount = report.rowCount ?? rows.length;
    const t = report.totals?.[0]?.metricValues;
    return {
      date_range: custom_range ? `${startDate}..${endDate}` : date_range,
      row_count: rowCount,
      rows_returned: rows.length,
      truncated: rowCount > rows.length,
      totals: t
        ? { sessions: num(t[0]?.value), users: num(t[1]?.value), conversions: num(t[2]?.value), revenue: num(t[3]?.value) }
        : null,
      conversions_metric: "keyEvents",
      rows,
    };
  },
};
