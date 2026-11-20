import type { McpCallResult, McpTool } from "../types";
import type { ToolSpec } from "@/services/tools/types";
import { listEmailListsTool } from "@/services/tools/outbound/list_email_lists";
import { proposeOutboundEmailTool } from "@/services/tools/outbound/propose_email";
import { ExpectedToolError } from "@/services/tools/types";
import { zodToJsonSchema } from "@/services/tools/registry";

const PREFIX = "outbound__";

const TOOLS = [listEmailListsTool, proposeOutboundEmailTool] as ToolSpec[];

export function listOutboundTools(): McpTool[] {
  return TOOLS.map((t) => {
    const schema = zodToJsonSchema(t.input_schema);
    if (schema.type !== "object") {
      throw new Error(`Tool ${t.name} must be a top-level z.object()`);
    }
    return {
      server_id: "outbound",
      tool_name: t.name.slice(PREFIX.length),
      description: t.description,
      effect: t.effect,
      input_schema: schema as { type: "object"; [k: string]: unknown },
    };
  });
}

export type OutboundToolCtx = {
  tenant_id: string;
  emit_decision?: (decision_class: string, body: unknown) => Promise<string>;
  run_id?: string;
  agent_slug?: string;
  run_trigger?: string;
};

export async function callOutboundTool(
  ctx: OutboundToolCtx,
  tool_name: string,
  args: unknown,
): Promise<McpCallResult> {
  const start = Date.now();
  const spec = TOOLS.find((t) => t.name === `${PREFIX}${tool_name}`);
  if (!spec) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: "tool_unknown", message: `outbound/${tool_name} not registered` }),
      ms: Date.now() - start,
    };
  }
  const parsed = spec.input_schema.safeParse(args ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: "invalid_input", message: parsed.error.message }),
      ms: Date.now() - start,
    };
  }
  try {
    const output = await spec.execute(
      {
        tenant_id: ctx.tenant_id,
        emit_decision: ctx.emit_decision,
        run_id: ctx.run_id,
        agent_slug: ctx.agent_slug,
        run_trigger: ctx.run_trigger,
        log: (msg: string, meta?: Record<string, unknown>) => {
          console.log(`[mcp/internal/outbound/${tool_name}] ${msg}`, meta ?? "");
        },
      },
      parsed.data,
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
