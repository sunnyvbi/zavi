import type { McpCallResult, McpTool } from "@/services/mcp/types";
import { ExpectedToolError, type ToolSpec } from "@/services/tools/types";
import { zodToJsonSchema } from "@/services/tools/registry";
import { CREATOR_MARKETPLACE_ENABLED } from "@zavi/shared";
import { creatorMessageTool } from "./creator_message";
import { creatorOfferTool } from "./creator_offer";
import { creatorBookPackageTool } from "./creator_book_package";

export const CREATOR_SERVER_ID = "creator";

export const CREATOR_TOOLS: readonly ToolSpec[] = CREATOR_MARKETPLACE_ENABLED
  ? [creatorMessageTool, creatorOfferTool, creatorBookPackageTool]
  : [];

export function listCreatorTools(): McpTool[] {
  return CREATOR_TOOLS.map((t) => {
    const schema = zodToJsonSchema(t.input_schema);
    if (schema.type !== "object") throw new Error(`Tool ${t.name} must be a top-level z.object()`);
    return {
      server_id: CREATOR_SERVER_ID,
      tool_name: t.name.replace(/^creator_/, ""),
      description: t.description,
      effect: t.effect,
      input_schema: schema as { type: "object"; [k: string]: unknown },
    };
  });
}

export type CreatorToolCallCtx = {
  tenant_id: string;
  run_id?: string;
  run_trigger?: string;
  writes_suppressed?: boolean;
  redo?: boolean;
  top_action_run?: boolean;
  emit_decision?: (decision_class: string, body: unknown) => Promise<string>;
};

export async function callCreatorTool(ctx: CreatorToolCallCtx, tool_name: string, args: unknown): Promise<McpCallResult> {
  const start = Date.now();
  const spec = CREATOR_TOOLS.find((t) => t.name === `creator_${tool_name}`);
  if (!spec) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: "tool_unknown", message: `creator/${tool_name} not registered` }),
      ms: Date.now() - start,
    };
  }
  try {
    const parsed = spec.input_schema.parse(args);
    const output = await spec.execute(
      {
        tenant_id: ctx.tenant_id,
        run_id: ctx.run_id,
        run_trigger: ctx.run_trigger,
        writes_suppressed: ctx.writes_suppressed,
        redo: ctx.redo,
        top_action_run: ctx.top_action_run,
        emit_decision: ctx.emit_decision,
        log: (msg: string, meta?: Record<string, unknown>) => {
          console.log(`[mcp/internal/creator/${tool_name}] ${msg}`, meta ?? "");
        },
      } as Parameters<ToolSpec["execute"]>[0],
      parsed,
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
