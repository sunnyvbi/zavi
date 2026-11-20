
import type { McpCallResult, McpTool } from "../types";
import { withMetaCaller } from "@/services/tools/meta-ads/_cooldown";
import { metaListCampaignsTool } from "@/services/tools/meta-ads/list_campaigns";
import { metaListAdSetsTool } from "@/services/tools/meta-ads/list_ad_sets";
import { metaListAdsTool } from "@/services/tools/meta-ads/list_ads";
import { metaPixelHealthTool } from "@/services/tools/meta-ads/pixel_health";
import { metaSearchInterestsTool } from "@/services/tools/meta-ads/search_interests";
import { metaListCustomAudiencesTool } from "@/services/tools/meta-ads/list_custom_audiences";
import { metaAnalystBriefTool } from "@/services/tools/meta-ads/analyst_brief";
import { metaDailySeriesTool } from "@/services/tools/meta-ads/daily_series_tool";
import { metaRecentChangesTool } from "@/services/tools/meta-ads/recent_changes_tool";
import { metaProposeBudgetChangeTool } from "@/services/tools/meta-ads/write/propose_budget_change";
import { metaProposeStatusChangeTool } from "@/services/tools/meta-ads/write/propose_status_change";
import { metaProposeLocationsTool } from "@/services/tools/meta-ads/write/propose_locations";
import { metaProposeNewAdSetTool } from "@/services/tools/meta-ads/write/propose_new_ad_set";
import {
  metaProposeCustomAudienceTool,
  metaProposeDuplicateTool,
  metaProposeNewAdTool,
} from "@/services/tools/meta-ads/write/propose_launch";
import {
  metaProposeCampaignDeleteTool,
  metaProposeCampaignUpdateTool,
  metaProposeNewCampaignTool,
} from "@/services/tools/meta-ads/write/propose_campaign";
import { metaProposeCampaignLaunchTool } from "@/services/tools/meta-ads/write/propose_campaign_launch";
import { metaProposeAdSetUpdateTool, metaProposeAdUpdateTool } from "@/services/tools/meta-ads/write/propose_edit";
import { metaProposeAssetUploadTool, metaProposeCreativeTool } from "@/services/tools/meta-ads/write/propose_creative";
import { metaListCreativeAssetsTool, metaPreviewTool } from "@/services/tools/meta-ads/creative_reads";
import { metaListMeasurementTool } from "@/services/tools/meta-ads/measurement_reads";
import { metaProposeCustomConversionTool } from "@/services/tools/meta-ads/write/propose_measurement";
import { metaListLeadFormsTool, metaListPagesTool } from "@/services/tools/meta-ads/pages";
import { metaProposeLeadFormTool } from "@/services/tools/meta-ads/write/propose_lead_form";
import { metaAccountReadTool } from "@/services/tools/meta-ads/account_read";
import { ExpectedToolError } from "@/services/tools/types";
import { zodToolErrorResult } from "./_zod-tool-error";
import { zodToJsonSchema } from "@/services/tools/registry";
import { resolveMetaAdsEmit } from "@/services/tools/meta-ads/write/_exec-action";
import { founderOrderEmit, founderTrust, serverFounderOf } from "@/services/growth/founder-order";
import { withCardLocation } from "@/services/approvals/card-location";
import { verifiedNameEmit } from "@/services/approvals/verified-ad-name";

export const META_ADS_TOOLS = [
  metaListCampaignsTool,
  metaListAdSetsTool,
  metaListAdsTool,
  metaPixelHealthTool,
  metaSearchInterestsTool,
  metaListCustomAudiencesTool,
  metaAnalystBriefTool,
  metaDailySeriesTool,
  metaRecentChangesTool,
  metaProposeBudgetChangeTool,
  metaProposeStatusChangeTool,
  metaProposeLocationsTool,
  metaProposeNewAdSetTool,
  metaProposeDuplicateTool,
  metaProposeNewAdTool,
  metaProposeCustomAudienceTool,
  metaProposeCampaignLaunchTool,
  metaProposeNewCampaignTool,
  metaProposeCampaignUpdateTool,
  metaProposeCampaignDeleteTool,
  metaProposeAdSetUpdateTool,
  metaProposeAdUpdateTool,
  metaListCreativeAssetsTool,
  metaPreviewTool,
  metaProposeCreativeTool,
  metaProposeAssetUploadTool,
  metaListMeasurementTool,
  metaProposeCustomConversionTool,
  metaListPagesTool,
  metaListLeadFormsTool,
  metaProposeLeadFormTool,
  metaAccountReadTool,
];

export function listMetaAdsTools(): McpTool[] {
  return META_ADS_TOOLS.map((t) => {
    const schema = zodToJsonSchema(t.input_schema);
    if (schema.type !== "object") {
      throw new Error(`Tool ${t.name} must be a top-level z.object()`);
    }
    const tool_name = t.name.replace(/^meta_ads_/, "");
    return {
      server_id: "meta_ads",
      tool_name,
      description: t.description,
      effect: t.effect,
      input_schema: schema as { type: "object"; [k: string]: unknown },
    };
  });
}

export type MetaAdsToolCtx = {
  tenant_id: string;
  emit_decision?: (decision_class: string, body: unknown) => Promise<string>;
  run_trigger?: string;
  untrusted_context?: boolean;
  captured_page_context?: boolean;
  verified_member_email_reply?: boolean;
  top_action_run?: boolean;
  founder_chat_order?: boolean;
  founder_order_unverified?: boolean;
  founder_order_tell?: boolean;
  founder_order_group?: string;
  rules_steered?: { budget: boolean; status: boolean };
  run_id?: string;
  writes_suppressed?: boolean;
  redo?: boolean;
};

export async function callMetaAdsTool(
  ctx: MetaAdsToolCtx,
  tool_name: string,
  args: unknown,
): Promise<McpCallResult> {
  const start = Date.now();
  const legacyName = `meta_ads_${tool_name}`;
  const spec = META_ADS_TOOLS.find((t) => t.name === legacyName);
  if (!spec) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: "tool_unknown", message: `meta_ads/${tool_name} not registered` }),
      ms: Date.now() - start,
    };
  }
  const input = spec.input_schema.safeParse(args);
  if (!input.success) return zodToolErrorResult({ tenant_id: ctx.tenant_id, run_id: ctx.run_id ?? null }, "meta_ads", tool_name, input.error, Date.now() - start);
  try {
    const parsedInput = input.data;
    const resolved = await resolveMetaAdsEmit(ctx, serverFounderOf(founderTrust(ctx)));
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
      emit_decision,
      meta_rail: resolved === ctx.emit_decision ? ("decisions" as const) : ("channel_actions" as const),
      run_trigger: ctx.run_trigger,
      untrusted_context: ctx.untrusted_context,
      captured_page_context: ctx.captured_page_context,
      verified_member_email_reply: ctx.verified_member_email_reply,
      top_action_run: ctx.top_action_run,
      founder_chat_order: ctx.founder_chat_order,
      founder_order_unverified: ctx.founder_order_unverified,
      founder_order_tell: ctx.founder_order_tell,
      founder_order_group: ctx.founder_order_group,
      rules_steered: ctx.rules_steered,
      log: (msg: string, meta?: Record<string, unknown>) => {
        console.log(`[mcp/internal/meta_ads/${tool_name}] ${msg}`, meta ?? "");
      },
    };
    const output = await withCardLocation(
      ctx.tenant_id,
      await withMetaCaller(`tool:${tool_name}`, () => spec.execute(toolCtx, parsedInput)),
      resolved === ctx.emit_decision ? "decisions" : "channel_actions",
      new Date(start - 5000).toISOString(),
      undefined,
      { run_id: ctx.run_id, trigger: ctx.run_trigger, writes_suppressed: ctx.writes_suppressed },
    );
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
