import {
  linkedinAdsBoundCampaigns,
  linkedinAdsLaunchReview,
  linkedinAdsProposeLaunch,
} from "@/services/tools/linkedin-ads/propose_launch_campaign";

import type { McpCallResult, McpTool } from "../types";
import { linkedinAdsListAccountsTool } from "@/services/tools/linkedin-ads/list_accounts";
import { linkedinAdsListCampaignGroupsTool } from "@/services/tools/linkedin-ads/list_campaign_groups";
import { linkedinAdsListCampaignsTool } from "@/services/tools/linkedin-ads/list_campaigns";
import { linkedinAdsReadAnalyticsTool } from "@/services/tools/linkedin-ads/read_analytics";
import { linkedinAdsDailySeriesTool } from "@/services/tools/linkedin-ads/daily_series";
import { linkedinAdsAnalystBriefTool } from "@/services/tools/linkedin-ads/analyst_brief";
import { linkedinAdsListAdsTool } from "@/services/tools/linkedin-ads/list_ads";
import { linkedinAdsRecentChangesTool } from "@/services/tools/linkedin-ads/recent_changes";
import { linkedinAdsMeasurementHealthTool } from "@/services/tools/linkedin-ads/measurement_health";
import { linkedinAdsListSavedAudiencesTool } from "@/services/tools/linkedin-ads/list_saved_audiences";
import { linkedinAdsProposePauseCampaignTool } from "@/services/tools/linkedin-ads/propose_pause_campaign";
import { linkedinAdsProposeResumeCampaignTool } from "@/services/tools/linkedin-ads/write/propose_resume_campaign";
import { linkedinAdsProposeBudgetChangeTool } from "@/services/tools/linkedin-ads/write/propose_budget_change";
import { linkedinAdsProposeTargetingChangeTool } from "@/services/tools/linkedin-ads/write/propose_targeting_change";
import { linkedinAdsProposeCampaignEditTool } from "@/services/tools/linkedin-ads/write/propose_campaign_edit";
import { linkedinAdsProposeCampaignGroupEditTool } from "@/services/tools/linkedin-ads/write/propose_campaign_group_edit";
import { linkedinAdsProposeArchiveTool } from "@/services/tools/linkedin-ads/write/propose_archive";
import { linkedinAdsProposeAdStatusTool } from "@/services/tools/linkedin-ads/write/propose_ad_status";
import { linkedinAdsProposeNewAdTool } from "@/services/tools/linkedin-ads/write/propose_new_ad";
import { linkedinAdsProposeAdSwapTool } from "@/services/tools/linkedin-ads/write/propose_ad_swap";
import { linkedinAdsProposeNewCampaignTool } from "@/services/tools/linkedin-ads/write/propose_new_campaign";
import { linkedinAdsProposeDuplicateTool } from "@/services/tools/linkedin-ads/write/propose_duplicate";
import { linkedinAdsSearchTargetingTool } from "@/services/tools/linkedin-ads/search_targeting";
import { linkedinAdsPreviewAdTool } from "@/services/tools/linkedin-ads/preview_ad";
import { linkedinAdsListMediaTool } from "@/services/tools/linkedin-ads/list_media";
import { resolveLinkedInAdsEmit } from "@/services/tools/linkedin-ads/_exec-action";
import type { EmitDecisionFn } from "@/services/channels/exec-emit";
import { ExpectedToolError } from "@/services/tools/types";
import { zodToJsonSchema } from "@/services/tools/registry";
import { comingSoonMessage, isChannelLocked } from "@/services/channels/lock";

const TOOLS = [
  linkedinAdsBoundCampaigns,
  linkedinAdsLaunchReview,
  linkedinAdsProposeLaunch,
  linkedinAdsListAccountsTool,
  linkedinAdsListCampaignGroupsTool,
  linkedinAdsListCampaignsTool,
  linkedinAdsReadAnalyticsTool,
  linkedinAdsDailySeriesTool,
  linkedinAdsAnalystBriefTool,
  linkedinAdsListAdsTool,
  linkedinAdsRecentChangesTool,
  linkedinAdsMeasurementHealthTool,
  linkedinAdsListSavedAudiencesTool,
  linkedinAdsProposePauseCampaignTool,
  linkedinAdsProposeResumeCampaignTool,
  linkedinAdsProposeBudgetChangeTool,
  linkedinAdsProposeTargetingChangeTool,
  linkedinAdsProposeCampaignEditTool,
  linkedinAdsProposeCampaignGroupEditTool,
  linkedinAdsProposeArchiveTool,
  linkedinAdsProposeAdStatusTool,
  linkedinAdsProposeNewAdTool,
  linkedinAdsProposeAdSwapTool,
  linkedinAdsProposeNewCampaignTool,
  linkedinAdsProposeDuplicateTool,
  linkedinAdsSearchTargetingTool,
  linkedinAdsPreviewAdTool,
  linkedinAdsListMediaTool,
];

const LAUNCH_TOOLS = new Set([
  linkedinAdsBoundCampaigns.name,
  linkedinAdsLaunchReview.name,
  linkedinAdsProposeLaunch.name,
]);

export function listLinkedinAdsTools(): McpTool[] {
  return TOOLS.map((t) => {
    const schema = zodToJsonSchema(t.input_schema);
    if (schema.type !== "object")
      throw new Error(`Tool ${t.name} must be a top-level z.object()`);
    return {
      server_id: "linkedin_ads",
      tool_name: t.name.replace(/^linkedin_ads_/, ""),
      description: t.description,
      effect: t.effect,
      input_schema: schema as { type: "object"; [k: string]: unknown },
    };
  });
}

export type LinkedinAdsToolCtx = {
  tenant_id: string;
  run_trigger?: string;
  run_id?: string;
  writes_suppressed?: boolean;
  redo?: boolean;
  emit_decision?: EmitDecisionFn;
  untrusted_context?: boolean;
  captured_page_context?: boolean;
  verified_member_email_reply?: boolean;
  top_action_run?: boolean;
  founder_chat_order?: boolean;
  founder_order_unverified?: boolean;
  rules_steered?: { budget: boolean; status: boolean };
};

export async function callLinkedinAdsTool(
  ctx: LinkedinAdsToolCtx,
  tool_name: string,
  args: unknown,
): Promise<McpCallResult> {
  const start = Date.now();
  const spec = TOOLS.find((t) => t.name === `linkedin_ads_${tool_name}`);
  if (!spec) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({
        error: "tool_unknown",
        message: `linkedin_ads/${tool_name} not registered`,
      }),
      ms: Date.now() - start,
    };
  }
  try {
    if (LAUNCH_TOOLS.has(spec.name) && (await isChannelLocked("linkedin_ads")))
      throw new ExpectedToolError("coming_soon", comingSoonMessage("LinkedIn Ads"));
    const parsedInput = spec.input_schema.parse(args);
    const output = await spec.execute(
      {
        tenant_id: ctx.tenant_id,
        run_id: ctx.run_id,
        run_trigger: ctx.run_trigger,
        untrusted_context: ctx.untrusted_context,
        captured_page_context: ctx.captured_page_context,
        verified_member_email_reply: ctx.verified_member_email_reply,
        top_action_run: ctx.top_action_run,
        founder_chat_order: ctx.founder_chat_order,
        founder_order_unverified: ctx.founder_order_unverified,
        rules_steered: ctx.rules_steered,
        emit_decision:
          spec.effect === "write"
            ? await resolveLinkedInAdsEmit(ctx)
            : undefined,
        log: (msg: string, meta?: Record<string, unknown>) => {
          console.log(
            `[mcp/internal/linkedin-ads/${tool_name}] ${msg}`,
            meta ?? "",
          );
        },
      },
      parsedInput,
    );
    return {
      ok: true,
      is_error: false,
      content: JSON.stringify(output),
      ms: Date.now() - start,
    };
  } catch (e) {
    if (e instanceof ExpectedToolError) {
      return {
        ok: false,
        is_error: true,
        content: JSON.stringify({
          error: e.code,
          message: e.message,
          ...(e.meta ? { meta: e.meta } : {}),
        }),
        ms: Date.now() - start,
      };
    }
    throw e;
  }
}
