
import type { McpCallResult, McpTool } from "../types";
import { diagnoseFunnelTool } from "@/services/tools/growth/diagnose_funnel";
import { readAdsPerfTool } from "@/services/tools/growth/read_ads_perf";
import { readCohortTool } from "@/services/tools/growth/read_cohort";
import { seoAuditTool } from "@/services/tools/growth/seo_audit";
import { geoVisibilityTool } from "@/services/tools/growth/geo_visibility";
import { geoReadinessTool } from "@/services/tools/growth/geo_readiness";
import { liquidityGapTool } from "@/services/tools/growth/liquidity_gap";
import { contentPunchlistTool } from "@/services/tools/growth/content_punchlist";
import { readActionOutcomesTool } from "@/services/tools/growth/read_action_outcomes";
import { readRevenueTool } from "@/services/tools/growth/read_revenue";
import { readExperimentLedgerTool } from "@/services/tools/growth/read_experiment_ledger";
import { readVerifiedBookingsByCampaignTool } from "@/services/tools/growth/read_verified_bookings_by_campaign";
import { marketplaceIntelligenceTool } from "@/services/tools/growth/marketplace_intelligence";
import { readMetricHistoryTool } from "@/services/tools/analytics/read_metric_history";
import { getMetricTool } from "@/services/tools/analytics/get_metric";
import { computeTool } from "@/services/tools/analytics/compute";
import { recordDataNoteTool, saveVerifiedQueryTool } from "@/services/tools/analytics/record_data_note";
import { explainChangeTool } from "@/services/tools/analytics/explain_change";
import { growthConstraintDiagnosisTool } from "@/services/tools/growth/growth_constraint_diagnosis";
import { proposeCreativeBriefTool } from "@/services/tools/growth/propose_creative_brief";
import { searchHumanMembersTool } from "@/services/tools/growth/search_humans";
import { confirmOutcomeFieldsTool, readOutcomeFieldsTool } from "@/services/tools/growth/outcome_fields";
import { confirmUtilizationMapTool, utilizationByLocationTool } from "@/services/tools/growth/utilization";
import { ExpectedToolError, type ToolContext } from "@/services/tools/types";
import { zodToJsonSchema } from "@/services/tools/registry";
import { CREATOR_MARKETPLACE_ENABLED } from "@zavi/shared";

import { readBusinessControlsTool, proposeBusinessControlsTool } from "@/services/tools/growth/business_controls";
import { recordCardAnswerTool } from "@/services/tools/growth/record_card_answer";
import { startChannelWorkTool } from "@/services/tools/growth/start_channel_work";
import { adBudgetRoomTool } from "@/services/tools/growth/ad_budget_room";

const TOOLS = [
  readBusinessControlsTool,
  proposeBusinessControlsTool,
  startChannelWorkTool,
  recordCardAnswerTool,
  diagnoseFunnelTool,
  growthConstraintDiagnosisTool,
  readAdsPerfTool,
  readCohortTool,
  seoAuditTool,
  geoVisibilityTool,
  geoReadinessTool,
  liquidityGapTool,
  contentPunchlistTool,
  readActionOutcomesTool,
  adBudgetRoomTool,
  readRevenueTool,
  readExperimentLedgerTool,
  readVerifiedBookingsByCampaignTool,
  marketplaceIntelligenceTool,
  readMetricHistoryTool,
  getMetricTool,
  computeTool,
  recordDataNoteTool,
  saveVerifiedQueryTool,
  readOutcomeFieldsTool,
  confirmOutcomeFieldsTool,
  utilizationByLocationTool,
  confirmUtilizationMapTool,
  explainChangeTool,
  proposeCreativeBriefTool,
  ...(CREATOR_MARKETPLACE_ENABLED ? [searchHumanMembersTool] : []),
];

export function listGrowthTools(): McpTool[] {
  return TOOLS.map((t) => {
    const schema = zodToJsonSchema(t.input_schema);
    if (schema.type !== "object") {
      throw new Error(`Tool ${t.name} must be a top-level z.object()`);
    }
    const tool_name = t.name.replace(/^growth_/, "");
    return {
      server_id: "growth",
      tool_name,
      description: t.description,
      effect: t.effect,
      input_schema: schema as { type: "object"; [k: string]: unknown },
    };
  });
}

export async function callGrowthTool(
  tenant_id: string,
  tool_name: string,
  args: unknown,
  run_id?: string,
  identity?: Pick<ToolContext, "agent_slug" | "run_trigger" | "untrusted_context" | "captured_page_context" | "actor" | "writes_suppressed" | "emit_decision" | "founder_chat_order" | "founder_order_unverified">,
): Promise<McpCallResult> {
  const start = Date.now();
  const legacyName = `growth_${tool_name}`;
  const spec = TOOLS.find((t) => t.name === legacyName);
  if (!spec) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({
        error: "tool_unknown",
        message: `growth/${tool_name} not registered`,
      }),
      ms: Date.now() - start,
    };
  }
  let parsedInput: unknown;
  try {
    parsedInput = spec.input_schema.parse(args);
  } catch (e) {
    if ((e as { name?: string })?.name === "ZodError") {
      return {
        ok: false,
        is_error: true,
        content: JSON.stringify({ error: "tool_input_invalid", message: (e as Error).message }),
        ms: Date.now() - start,
      };
    }
    throw e;
  }
  if (tool_name === "constraint_diagnosis") {
    const { resolveBusinessShape } = await import("@/services/growth/business-shape");
    if ((await resolveBusinessShape(tenant_id)) !== "marketplace") {
      return {
        ok: false,
        is_error: true,
        content: JSON.stringify({
          error: "marketplace_only",
          message: "This diagnosis reads buyers and sellers, so it runs for marketplaces only. Use growth__diagnose_funnel for this business.",
        }),
        ms: Date.now() - start,
      };
    }
  }
  try {
    const ctx: ToolContext = {
      ...(identity ?? {}),
      tenant_id,
      run_id,
      log: (msg: string, meta?: Record<string, unknown>) => {
        console.log(`[mcp/internal/growth/${tool_name}] ${msg}`, meta ?? "");
      },
    };
    const output = await spec.execute(ctx, parsedInput as Parameters<typeof spec.execute>[1]);
    return { ok: true, is_error: false, content: JSON.stringify(output), ms: Date.now() - start };
  } catch (e) {
    if (e instanceof ExpectedToolError) {
      return {
        ok: false,
        is_error: true,
        content: JSON.stringify({ error: e.code, message: e.message, ...(e.meta ? { meta: e.meta } : {}) }),
        ms: Date.now() - start,
      };
    }
    throw e;
  }
}
