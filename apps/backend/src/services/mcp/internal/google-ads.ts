
import type { McpCallResult, McpTool } from "../types";
import { listCampaignsTool } from "@/services/tools/google-ads/list_campaigns";
import { listAdGroupsTool } from "@/services/tools/google-ads/list_ad_groups";
import { conversionTrackingHealthTool } from "@/services/tools/google-ads/conversion_tracking_health";
import { changeHistoryTool } from "@/services/tools/google-ads/change_history";
import { conversionLagTool } from "@/services/tools/google-ads/conversion_lag";
import { searchTermsTool } from "@/services/tools/google-ads/search_terms";
import { campaignDiagnosticsTool } from "@/services/tools/google-ads/campaign_diagnostics";
import { existingNegativesTool } from "@/services/tools/google-ads/existing_negatives";
import { listLocationsTool } from "@/services/tools/google-ads/list_locations";
import { listAdsTool } from "@/services/tools/google-ads/list_ads";
import { listKeywordsTool } from "@/services/tools/google-ads/list_keywords";
import { listVideoCampaignsTool } from "@/services/tools/google-ads/list_video_campaigns";
import { videoPerformanceTool } from "@/services/tools/google-ads/video_performance";
import { googleProposeBudgetChangeTool } from "@/services/tools/google-ads/write/propose_budget_change";
import { googleProposeStatusChangeTool } from "@/services/tools/google-ads/write/propose_status_change";
import { googleProposeNewCampaignTool } from "@/services/tools/google-ads/write/propose_new_campaign";
import { googleProposeCampaignUpdateTool } from "@/services/tools/google-ads/write/propose_campaign_update";
import { googleProposeNewAdGroupTool } from "@/services/tools/google-ads/write/propose_new_ad_group";
import { googleProposeAdGroupUpdateTool } from "@/services/tools/google-ads/write/propose_ad_group_update";
import { googleProposeNewAdTool } from "@/services/tools/google-ads/write/propose_new_ad";
import { googleProposeKeywordsTool } from "@/services/tools/google-ads/write/propose_keywords";
import { googleProposeRemovalTool } from "@/services/tools/google-ads/write/propose_removal";
import { googleProposeVideoCampaignTool } from "@/services/tools/google-ads/write/propose_video_campaign";
import { googleProposePmaxCampaignTool } from "@/services/tools/google-ads/write/propose_pmax_campaign";
import { googleProposeVideoAdTool } from "@/services/tools/google-ads/write/propose_video_ad";
import { ExpectedToolError } from "@/services/tools/types";
import { zodToolErrorResult } from "./_zod-tool-error";
import { zodToJsonSchema } from "@/services/tools/registry";
import { resolveGoogleAdsEmit } from "@/services/tools/google-ads/write/_exec-action";
import { founderOrderEmit, founderTrust, serverFounderOf } from "@/services/growth/founder-order";
import { withCardLocation } from "@/services/approvals/card-location";
import { verifiedNameEmit } from "@/services/approvals/verified-ad-name";

export const GOOGLE_ADS_TOOLS = [
  listCampaignsTool,
  listAdGroupsTool,
  conversionTrackingHealthTool,
  changeHistoryTool,
  conversionLagTool,
  searchTermsTool,
  campaignDiagnosticsTool,
  existingNegativesTool,
  listLocationsTool,
  listAdsTool,
  listKeywordsTool,
  listVideoCampaignsTool,
  videoPerformanceTool,
  googleProposeBudgetChangeTool,
  googleProposeStatusChangeTool,
  googleProposeNewCampaignTool,
  googleProposeCampaignUpdateTool,
  googleProposeNewAdGroupTool,
  googleProposeAdGroupUpdateTool,
  googleProposeNewAdTool,
  googleProposeKeywordsTool,
  googleProposeRemovalTool,
  googleProposeVideoCampaignTool,
  googleProposeVideoAdTool,
  googleProposePmaxCampaignTool,
];

export function listGoogleAdsTools(): McpTool[] {
  return GOOGLE_ADS_TOOLS.map((t) => {
    const schema = zodToJsonSchema(t.input_schema);
    if (schema.type !== "object") {
      throw new Error(`Tool ${t.name} must be a top-level z.object()`);
    }
    const tool_name = t.name.replace(/^google_ads_/, "");
    return {
      server_id: "google_ads",
      tool_name,
      description: t.description,
      effect: t.effect,
      input_schema: schema as { type: "object"; [k: string]: unknown },
    };
  });
}

export type GoogleAdsToolCtx = {
  tenant_id: string;
  run_trigger?: string;
  rules_steered?: { budget: boolean; status: boolean };
  untrusted_context?: boolean;
  captured_page_context?: boolean;
  emit_decision?: (decision_class: string, body: unknown) => Promise<string>;
  run_id?: string;
  writes_suppressed?: boolean;
  redo?: boolean;
  top_action_run?: boolean;
  founder_chat_order?: boolean;
  founder_order_unverified?: boolean;
  founder_order_tell?: boolean;
  founder_order_group?: string;
};

export async function callGoogleAdsTool(
  ctx: GoogleAdsToolCtx,
  tool_name: string,
  args: unknown,
): Promise<McpCallResult> {
  const start = Date.now();
  const legacyName = `google_ads_${tool_name}`;
  const spec = GOOGLE_ADS_TOOLS.find((t) => t.name === legacyName);
  if (!spec) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: "tool_unknown", message: `google_ads/${tool_name} not registered` }),
      ms: Date.now() - start,
    };
  }
  const input = spec.input_schema.safeParse(args);
  if (!input.success) return zodToolErrorResult({ tenant_id: ctx.tenant_id, run_id: ctx.run_id ?? null }, "google_ads", tool_name, input.error, Date.now() - start);
  try {
    const parsedInput = input.data;
    const resolved = await resolveGoogleAdsEmit(ctx, serverFounderOf(founderTrust(ctx)));
    const emit_decision = verifiedNameEmit(
      ctx.tenant_id,
      founderOrderEmit(
        founderTrust(ctx),
        resolved,
        resolved === ctx.emit_decision ? "decisions" : "channel_actions",
      ),
    );
    const toolCtx = {
      tenant_id: ctx.tenant_id,
      run_id: ctx.run_id,
      run_trigger: ctx.run_trigger,
      founder_chat_order: ctx.founder_chat_order,
      founder_order_unverified: ctx.founder_order_unverified,
      founder_order_tell: ctx.founder_order_tell,
      founder_order_group: ctx.founder_order_group,
      rules_steered: ctx.rules_steered,
      untrusted_context: ctx.untrusted_context,
      captured_page_context: ctx.captured_page_context,
      top_action_run: ctx.top_action_run,
      emit_decision,
      log: (msg: string, meta?: Record<string, unknown>) => {
        console.log(`[mcp/internal/google_ads/${tool_name}] ${msg}`, meta ?? "");
      },
    };
    const output = await withCardLocation(ctx.tenant_id, await spec.execute(toolCtx, parsedInput), resolved === ctx.emit_decision ? "decisions" : "channel_actions", new Date(start - 5000).toISOString(), undefined, {
      run_id: ctx.run_id,
      trigger: ctx.run_trigger,
      writes_suppressed: ctx.writes_suppressed,
    });
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
