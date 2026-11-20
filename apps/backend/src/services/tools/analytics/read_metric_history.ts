
import { z } from "zod";
import { METRIC_REGISTRY } from "@/services/analytics/metric-registry";
import { readMetricHistory } from "@/services/analytics/record-metric-snapshot";
import type { ToolSpec } from "@/services/tools/types";

const METRIC_KEYS = Object.keys(METRIC_REGISTRY) as [string, ...string[]];

const inputSchema = z.object({
  metric_key: z.enum(METRIC_KEYS),
  window_kind: z.enum(["rolling_7d","day","calendar_week","point"]).optional(),
  limit: z.number().int().min(1).max(90).default(30),
});

export const readMetricHistoryTool: ToolSpec = {
  name: "growth_read_metric_history",
  effect: "read",
  description:
    "Read the stored snapshot history for ONE warehouse metric (weekly_signups, weekly_bookings, ads_spend_7d, ads_cpa_7d, stripe_mrr), newest first. Each row is an OBSERVATIONAL reading {value, status, window_kind, window_end, source} — a trend here is correlation over time, NOT causal proof that any action moved the metric; never claim causation from these rows alone. Rows with status 'unavailable' mean the source could not be read for that window — not a zero, never a real reading. has_data:false means no snapshots exist yet for this metric: say so, never invent a trend. Compare same-window_kind rows ~7 days apart for week-over-week reads; never day-over-day on rolling windows.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { metric_key, window_kind, limit } = inputSchema.parse(input);
    const def = METRIC_REGISTRY[metric_key];
    const rows = await readMetricHistory(ctx.tenant_id, metric_key, {
      window_kind: window_kind ?? def.window_kind,
      limit,
    });
    return {
      has_data: rows.length > 0,
      metric: def,
      rows,
      note:
        rows.length === 0
          ? "No stored snapshots for this metric yet (the warehouse may not have started recording it). Say exactly that — never fabricate a history or a trend."
          : "Observational readings only — trends are correlational, not causal. 'unavailable' rows are read failures, not zeros.",
    };
  },
};
