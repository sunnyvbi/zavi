
import type { McpCallResult, McpTool } from "../types";
import { generatedVideoProposeTool } from "@/services/tools/generated-video/propose_video";
import { generatedVideoAnimateTool } from "@/services/tools/generated-video/animate_image";
import { ExpectedToolError } from "@/services/tools/types";
import { zodToJsonSchema } from "@/services/tools/registry";

const TOOLS = [generatedVideoProposeTool, generatedVideoAnimateTool];

export function listGeneratedVideoTools(): McpTool[] {
  return TOOLS.map((t) => {
    const schema = zodToJsonSchema(t.input_schema);
    if (schema.type !== "object") {
      throw new Error(`Tool ${t.name} must be a top-level z.object()`);
    }
    const tool_name = t.name.replace(/^generated_video_/, "");
    return {
      server_id: "generated_video",
      tool_name,
      description: t.description,
      effect: t.effect,
      input_schema: schema as { type: "object"; [k: string]: unknown },
    };
  });
}

export type GeneratedVideoToolCtx = {
  tenant_id: string;
  run_trigger?: string;
  emit_decision?: (decision_class: string, body: unknown) => Promise<string>;
  run_id?: string;
  writes_suppressed?: boolean;
  redo?: boolean;
  founder_chat_order?: boolean;
  founder_order_unverified?: boolean;
  actor_user_id?: string | null;
};

export async function callGeneratedVideoTool(
  ctx: GeneratedVideoToolCtx,
  tool_name: string,
  args: unknown,
): Promise<McpCallResult> {
  const start = Date.now();
  const legacyName = `generated_video_${tool_name}`;
  const spec = TOOLS.find((t) => t.name === legacyName);
  if (!spec) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: "tool_unknown", message: `generated_video/${tool_name} not registered` }),
      ms: Date.now() - start,
    };
  }
  try {
    const parsedInput = spec.input_schema.parse(args);
    const toolCtx = {
      tenant_id: ctx.tenant_id,
      emit_decision: ctx.emit_decision,
      run_id: ctx.run_id,
      run_trigger: ctx.run_trigger,
      writes_suppressed: ctx.writes_suppressed,
      redo: ctx.redo,
      founder_chat_order: ctx.founder_chat_order,
      founder_order_unverified: ctx.founder_order_unverified,
      actor_user_id: ctx.actor_user_id,
      log: (msg: string, meta?: Record<string, unknown>) => {
        console.log(`[mcp/internal/generated_video/${tool_name}] ${msg}`, meta ?? "");
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
