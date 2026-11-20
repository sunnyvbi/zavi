
import type { McpCallResult, McpTool } from "../types";
import { tiktokAdsListAccountsTool } from "@/services/tools/tiktok-ads/list_accounts";
import { tiktokAdsListCampaignsTool } from "@/services/tools/tiktok-ads/list_campaigns";
import { tiktokAdsProposeBudgetChangeTool, tiktokAdsProposeStatusChangeTool } from "@/services/tools/tiktok-ads/propose_changes";
import { tiktokAdsLaunchReadinessTool, tiktokAdsProposeLaunchTool } from "@/services/tools/tiktok-ads/launch";
import { resolveTiktokAdsEmit } from "@/services/tools/tiktok-ads/_exec-action";
import { tiktokAdsListAdGroupsTool, tiktokAdsSearchLocationsTool, tiktokAdsTargetingOptionsTool } from "@/services/tools/tiktok-ads/read_tools";
import type { EmitDecisionFn } from "@/services/channels/exec-emit";
import { ExpectedToolError } from "@/services/tools/types";
import { honestComposioToolError } from "@/services/connectors/composio/account";
import { zodToJsonSchema } from "@/services/tools/registry";

const TOOLS = [
  tiktokAdsListAccountsTool,
  tiktokAdsListCampaignsTool,
  tiktokAdsListAdGroupsTool,
  tiktokAdsSearchLocationsTool,
  tiktokAdsTargetingOptionsTool,
  tiktokAdsProposeBudgetChangeTool,
  tiktokAdsProposeStatusChangeTool,
  tiktokAdsLaunchReadinessTool,
  tiktokAdsProposeLaunchTool,
];

const CHAT_EDIT_TOOLS: ReadonlySet<(typeof TOOLS)[number]> = new Set([tiktokAdsProposeBudgetChangeTool, tiktokAdsProposeStatusChangeTool]);

export function listTikTokAdsTools(): McpTool[] {
  return TOOLS.map((t) => {
    const schema = zodToJsonSchema(t.input_schema);
    if (schema.type !== "object") {
      throw new Error(`Tool ${t.name} must be a top-level z.object()`);
    }
    const tool_name = t.name.replace(/^tiktok_ads_/, "");
    return {
      server_id: "tiktok_ads",
      tool_name,
      description: t.description,
      effect: t.effect,
      input_schema: schema as { type: "object"; [k: string]: unknown },
    };
  });
}

export type TikTokAdsToolCtx = {
  tenant_id: string;
  run_trigger?: string;
  run_id?: string;
  writes_suppressed?: boolean;
  redo?: boolean;
  emit_decision?: EmitDecisionFn;
  top_action_run?: boolean;
};

export async function callTikTokAdsTool(
  ctx: TikTokAdsToolCtx,
  tool_name: string,
  args: unknown,
): Promise<McpCallResult> {
  const start = Date.now();
  const legacyName = `tiktok_ads_${tool_name}`;
  const spec = TOOLS.find((t) => t.name === legacyName);
  if (!spec) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({
        error: "tool_unknown",
        message: `tiktok_ads/${tool_name} not registered`,
      }),
      ms: Date.now() - start,
    };
  }
  try {
    const parsedInput = spec.input_schema.parse(args);
    const toolCtx = {
      tenant_id: ctx.tenant_id,
      emit_decision: spec.effect === "write" ? await resolveTiktokAdsEmit(ctx, { chatEdit: CHAT_EDIT_TOOLS.has(spec) }) : undefined,
      writes_suppressed: ctx.writes_suppressed,
      redo: ctx.redo,
      top_action_run: ctx.top_action_run,
      log: (msg: string, meta?: Record<string, unknown>) => {
        console.log(`[mcp/internal/tiktok-ads/${tool_name}] ${msg}`, meta ?? "");
      },
    };
    const output = await spec.execute(toolCtx, parsedInput);
    return { ok: true, is_error: false, content: JSON.stringify(output), ms: Date.now() - start };
  } catch (thrown) {
    const e = await honestComposioToolError(ctx.tenant_id, "tiktok_ads", "TikTok Ads", thrown);
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
