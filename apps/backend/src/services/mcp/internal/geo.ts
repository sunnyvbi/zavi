
import type { McpCallResult, McpTool } from "../types";
import { geoProposePrTool } from "@/services/tools/geo/propose_pr";
import { ExpectedToolError, type ToolContext } from "@/services/tools/types";
import { geoStartAnswerCheckTool } from "@/services/tools/geo/start-answer-check";
import { zodToJsonSchema } from "@/services/tools/registry";

const TOOLS = [geoProposePrTool, geoStartAnswerCheckTool];

export function listGeoTools(): McpTool[] {
  return TOOLS.map((t) => {
    const schema = zodToJsonSchema(t.input_schema);
    if (schema.type !== "object") {
      throw new Error(`Tool ${t.name} must be a top-level z.object()`);
    }
    const tool_name = t.name.replace(/^geo_/, "");
    return {
      server_id: "geo",
      tool_name,
      description: t.description,
      effect: t.effect,
      input_schema: schema as { type: "object"; [k: string]: unknown },
    };
  });
}

export type GeoToolCtx = Pick<ToolContext, "founder_chat_order" | "founder_order_group" | "founder_order_unverified" | "untrusted_context" | "captured_page_context"> & {
  tenant_id: string;
  run_trigger?: string;
  run_id?: string;
  writes_suppressed?: boolean;
  redo?: boolean;
  chat_answer_turn?: boolean;
};

export async function callGeoTool(
  ctx: GeoToolCtx,
  tool_name: string,
  args: unknown,
): Promise<McpCallResult> {
  const start = Date.now();
  const legacyName = `geo_${tool_name}`;
  const spec = TOOLS.find((t) => t.name === legacyName);
  if (!spec) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: "tool_unknown", message: `geo/${tool_name} not registered` }),
      ms: Date.now() - start,
    };
  }
  try {
    const parsedInput = spec.input_schema.parse(args);
    const toolCtx = {
      founder_chat_order: ctx.founder_chat_order,
      founder_order_group: ctx.founder_order_group,
      founder_order_unverified: ctx.founder_order_unverified,
      untrusted_context: ctx.untrusted_context,
      captured_page_context: ctx.captured_page_context,
      tenant_id: ctx.tenant_id,
      run_id: ctx.run_id,
      run_trigger: ctx.run_trigger,
      writes_suppressed: ctx.writes_suppressed,
      redo: ctx.redo,
      chat_answer_turn: ctx.chat_answer_turn,
      log: (msg: string, meta?: Record<string, unknown>) => {
        console.log(`[mcp/internal/geo/${tool_name}] ${msg}`, meta ?? "");
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
