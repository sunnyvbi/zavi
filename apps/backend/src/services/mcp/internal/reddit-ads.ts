
import type { McpCallResult, McpTool } from "../types";
import { redditAdsListAccountsTool } from "@/services/tools/reddit-ads/list_accounts";
import { redditAdsListCampaignsTool } from "@/services/tools/reddit-ads/list_campaigns";
import { redditAdsProposePauseCampaignTool } from "@/services/tools/reddit-ads/propose_pause_campaign";
import { redditReadTools } from "@/services/tools/reddit-ads/read-tools";
import { resolveRedditAdsEmit } from "@/services/tools/reddit-ads/_exec-action";
import type { EmitDecisionFn } from "@/services/channels/exec-emit";
import { ExpectedToolError } from "@/services/tools/types";
import { honestComposioToolError } from "@/services/connectors/composio/account";
import { zodToJsonSchema } from "@/services/tools/registry";
import { redditLifecycleTools } from "@/services/tools/reddit-ads/lifecycle-tools";

const TOOLS = [...redditReadTools, ...redditLifecycleTools, redditAdsListAccountsTool, redditAdsListCampaignsTool, redditAdsProposePauseCampaignTool];

export function listRedditAdsTools(): McpTool[] {
  return TOOLS.map((t) => {
    const schema = zodToJsonSchema(t.input_schema);
    if (schema.type !== "object") {
      throw new Error(`Tool ${t.name} must be a top-level z.object()`);
    }
    const tool_name = t.name.replace(/^reddit_ads_/, "");
    return {
      server_id: "reddit_ads",
      tool_name,
      description: t.description,
      effect: t.effect,
      input_schema: schema as { type: "object"; [k: string]: unknown },
    };
  });
}

export type RedditAdsToolCtx = {
  tenant_id: string;
  run_trigger?: string;
  run_id?: string;
  writes_suppressed?: boolean;
  redo?: boolean;
  emit_decision?: EmitDecisionFn;
  top_action_run?: boolean;
};

export async function callRedditAdsTool(
  ctx: RedditAdsToolCtx,
  tool_name: string,
  args: unknown,
): Promise<McpCallResult> {
  const start = Date.now();
  const legacyName = `reddit_ads_${tool_name}`;
  const spec = TOOLS.find((t) => t.name === legacyName);
  if (!spec) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({
        error: "tool_unknown",
        message: `reddit_ads/${tool_name} not registered`,
      }),
      ms: Date.now() - start,
    };
  }
  try {
    const parsedInput = spec.input_schema.parse(args);
    const toolCtx = {
      tenant_id: ctx.tenant_id,
      emit_decision: spec.effect === "write" ? await resolveRedditAdsEmit(ctx) : undefined,
      top_action_run: ctx.top_action_run,
      log: (msg: string, meta?: Record<string, unknown>) => {
        console.log(`[mcp/internal/reddit-ads/${tool_name}] ${msg}`, meta ?? "");
      },
    };
    const output = await spec.execute(toolCtx, parsedInput);
    return { ok: true, is_error: false, content: JSON.stringify(output), ms: Date.now() - start };
  } catch (thrown) {
    const e = await honestComposioToolError(ctx.tenant_id, "reddit_ads", "Reddit Ads", thrown);
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
