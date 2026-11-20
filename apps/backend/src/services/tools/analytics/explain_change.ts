
import { z } from "zod";
import type { ToolContext, ToolSpec } from "@/services/tools/types";
import { CATALOG_METRIC_IDS } from "@/services/analytics/metric-registry";
import { WINDOW_PRESETS } from "@/services/analytics/metric-time";
import { resolveReportingTimezone, type ResolvedTz } from "@/services/analytics/tenant-timezone";
import { explainChange, type ExplainResult } from "@/services/analytics/explain-change";
import { recordFiguresFromPull } from "@/services/agents/engine/figure-ledger";

export const EXPLAIN_CHANGE_LEDGER_NAME = "growth__explain_change";

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

export const explainChangeInputSchema = z
  .object({
    metric_id: z.enum(CATALOG_METRIC_IDS),
    window: z
      .object({
        preset: z.enum(WINDOW_PRESETS).optional(),
        since: dateStr.optional(),
        until: dateStr.optional(),
      })
      .strict()
      .optional(),
    compare: z.enum(["previous_period", "previous_week", "previous_year"]).default("previous_period"),
  })
  .strict();

export type ExplainChangeDeps = {
  now: () => Date;
  resolveTz: (tenant_id: string) => Promise<ResolvedTz>;
  explain: typeof explainChange;
};

const realDeps: ExplainChangeDeps = {
  now: () => new Date(),
  resolveTz: (tenant_id) => resolveReportingTimezone(tenant_id),
  explain: explainChange,
};

export async function runExplainChange(ctx: ToolContext, raw: unknown, deps: ExplainChangeDeps = realDeps): Promise<ExplainResult & { tz: string }> {
  const input = explainChangeInputSchema.parse(raw);
  const { tz } = await deps.resolveTz(ctx.tenant_id);
  const out = await deps.explain(
    {
      tenant_id: ctx.tenant_id,
      tz,
      now: deps.now(),
      gateway: {
        tenant_id: ctx.tenant_id,
        caller: { kind: "agent", agent_slug: ctx.agent_slug ?? null, run_id: ctx.run_id ?? null, tool_name: EXPLAIN_CHANGE_LEDGER_NAME },
      },
    },
    { metric_id: input.metric_id, window: input.window, compare: input.compare },
  );
  const result = { ...out, tz };
  if (ctx.run_id) {
    try {
      recordFiguresFromPull(ctx.run_id, JSON.stringify(result), EXPLAIN_CHANGE_LEDGER_NAME);
    } catch {
    }
  }
  return result;
}

export const explainChangeTool: ToolSpec = {
  name: "growth_explain_change",
  effect: "read",
  description:
    "Explain WHY one catalog metric changed, computed in code: splits the change between a window and a compare window by every dimension the metric supports (source/medium, campaign, ad platform, country, device, landing page, search query) and returns each segment's contribution and share of the change, plus the top 3 drivers each with a high/medium/low confidence. " +
    "metric_id: a catalog id (see growth__get_metric). window: {preset} or {since, until} as YYYY-MM-DD in the tenant's reporting time zone (today excluded). compare: previous_period (default), previous_week (same days one week back, keeps weekdays aligned) or previous_year. " +
    "Quote drivers with their share and confidence as returned; never compute a share yourself. A status other than ok means there is no explanation: say why.",
  input_schema: explainChangeInputSchema,
  async execute(ctx, input) {
    return runExplainChange(ctx, input);
  },
};
