
import { linkedinTrackingLinkTool } from "@/services/tools/social/linkedin_tracking_link";
import type { McpCallResult, McpTool } from "../types";
import { socialProposePostTool } from "@/services/tools/social/propose_post";
import { socialProposeStandingOrderTool } from "@/services/tools/social/propose_standing_order";
import { socialListPostsTool } from "@/services/tools/social/list_posts";
import { ExpectedToolError } from "@/services/tools/types";
import { zodToJsonSchema } from "@/services/tools/registry";

const TOOLS = [socialProposePostTool, socialProposeStandingOrderTool, socialListPostsTool, linkedinTrackingLinkTool];

export function listSocialTools(): McpTool[] {
  return TOOLS.map((t) => {
    const schema = zodToJsonSchema(t.input_schema);
    if (schema.type !== "object") {
      throw new Error(`Tool ${t.name} must be a top-level z.object()`);
    }
    const tool_name = t.name.replace(/^social_/, "");
    return {
      server_id: "social",
      tool_name,
      description: t.description,
      effect: t.effect,
      input_schema: schema as { type: "object"; [k: string]: unknown },
    };
  });
}

export type SocialToolCtx = {
  tenant_id: string;
  emit_decision?: (decision_class: string, body: unknown) => Promise<string>;
  run_id?: string;
  agent_slug?: string;
  run_trigger?: string;
};

export async function callSocialTool(
  ctx: SocialToolCtx,
  tool_name: string,
  args: unknown,
): Promise<McpCallResult> {
  const start = Date.now();
  const legacyName = `social_${tool_name}`;
  const spec = TOOLS.find((t) => t.name === legacyName);
  if (!spec) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: "tool_unknown", message: `social/${tool_name} not registered` }),
      ms: Date.now() - start,
    };
  }
  try {
    const parsedInput = spec.input_schema.parse(args);
    const toolCtx = {
      tenant_id: ctx.tenant_id,
      emit_decision: ctx.emit_decision,
      run_id: ctx.run_id,
      agent_slug: ctx.agent_slug,
      run_trigger: ctx.run_trigger,
      log: (msg: string, meta?: Record<string, unknown>) => {
        console.log(`[mcp/internal/social/${tool_name}] ${msg}`, meta ?? "");
      },
    };
    const output = await spec.execute(toolCtx, parsedInput);
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
