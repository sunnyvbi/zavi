import type { McpCallResult, McpTool } from "../types";
import { xAdsListAccountsTool } from "@/services/tools/x-ads/list_accounts";
import { xAdsListCampaignsTool } from "@/services/tools/x-ads/list_campaigns";
import { xAdsListFundingInstrumentsTool } from "@/services/tools/x-ads/list_funding_instruments";
import { xAdsSearchLocationsTool } from "@/services/tools/x-ads/search_locations";
import { xAdsProposePauseCampaignTool, xAdsProposeResumeCampaignTool } from "@/services/tools/x-ads/propose_status";
import { xAdsProposeUpdateCampaignTool } from "@/services/tools/x-ads/propose_update_campaign";
import { xAdsProposeCreateCampaignTool } from "@/services/tools/x-ads/propose_create_campaign";
import { resolveXAdsEmit } from "@/services/tools/x-ads/_exec-action";
import type { EmitDecisionFn } from "@/services/channels/exec-emit";
import { ExpectedToolError } from "@/services/tools/types";
import { zodToJsonSchema } from "@/services/tools/registry";

import { xAdsProposeManageObjectsTool } from "@/services/tools/x-ads/manage_objects";
import { xAdsVerifyPermissionsTool, xAdsReadAdGroupsTool, xAdsCheckConversionsTool } from "@/services/tools/x-ads/read_management";

const TOOLS = [
  xAdsProposeManageObjectsTool, xAdsVerifyPermissionsTool, xAdsReadAdGroupsTool, xAdsCheckConversionsTool,
  xAdsListAccountsTool,
  xAdsListCampaignsTool,
  xAdsListFundingInstrumentsTool,
  xAdsSearchLocationsTool,
  xAdsProposePauseCampaignTool,
  xAdsProposeResumeCampaignTool,
  xAdsProposeUpdateCampaignTool,
  xAdsProposeCreateCampaignTool,
];

export function listXAdsTools(): McpTool[] {
  return TOOLS.map((t) => {
    const schema = zodToJsonSchema(t.input_schema);
    if (schema.type !== "object") throw new Error(`Tool ${t.name} must be a top-level z.object()`);
    return {
      server_id: "x_ads",
      tool_name: t.name.replace(/^x_ads_/, ""),
      description: t.description,
      effect: t.effect,
      input_schema: schema as { type: "object"; [k: string]: unknown },
    };
  });
}

export type XAdsToolCtx = {
  tenant_id: string;
  run_trigger?: string;
  run_id?: string;
  writes_suppressed?: boolean;
  redo?: boolean;
  emit_decision?: EmitDecisionFn;
  top_action_run?: boolean;
};

export async function callXAdsTool(ctx: XAdsToolCtx, tool_name: string, args: unknown): Promise<McpCallResult> {
  const start = Date.now();
  const spec = TOOLS.find((t) => t.name === `x_ads_${tool_name}`);
  if (!spec) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: "tool_unknown", message: `x_ads/${tool_name} not registered` }),
      ms: Date.now() - start,
    };
  }
  try {
    const parsedInput = spec.input_schema.parse(args);
    const output = await spec.execute(
      {
        tenant_id: ctx.tenant_id,
        emit_decision: spec.effect === "write" ? await resolveXAdsEmit(ctx) : undefined,
        top_action_run: ctx.top_action_run,
        log: (msg: string, meta?: Record<string, unknown>) => {
          console.log(`[mcp/internal/x-ads/${tool_name}] ${msg}`, meta ?? "");
        },
      },
      parsedInput,
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
