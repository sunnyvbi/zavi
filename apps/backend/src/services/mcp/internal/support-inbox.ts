
import type { McpCallResult, McpTool } from "../types";
import {
  supportInboxListThreadsTool,
  supportInboxGetThreadTool,
} from "@/services/tools/support-inbox/inbox";
import { ExpectedToolError } from "@/services/tools/types";
import { zodToJsonSchema } from "@/services/tools/registry";

export type SupportInboxCallCtx = {
  run_id?: string;
  agent_slug?: string;
  trigger?: string;
};

const TOOLS = [supportInboxListThreadsTool, supportInboxGetThreadTool];

export function listSupportInboxTools(): McpTool[] {
  return TOOLS.map((t) => {
    const schema = zodToJsonSchema(t.input_schema);
    if (schema.type !== "object") {
      throw new Error(`Tool ${t.name} must be a top-level z.object()`);
    }
    const tool_name = t.name.replace(/^support_inbox_/, "");
    return {
      server_id: "support_inbox",
      tool_name,
      description: t.description,
      effect: t.effect,
      input_schema: schema as { type: "object"; [k: string]: unknown },
    };
  });
}

export async function callSupportInboxTool(
  tenant_id: string,
  tool_name: string,
  args: unknown,
  mcpCtx?: SupportInboxCallCtx,
): Promise<McpCallResult> {
  const start = Date.now();
  const legacyName = `support_inbox_${tool_name}`;
  const spec = TOOLS.find((t) => t.name === legacyName);
  if (!spec) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({
        error: "tool_unknown",
        message: `support_inbox/${tool_name} not registered`,
      }),
      ms: Date.now() - start,
    };
  }
  try {
    const parsedInput = spec.input_schema.parse(args);
    const ctx = {
      tenant_id,
      run_id: mcpCtx?.run_id,
      agent_slug: mcpCtx?.agent_slug,
      run_trigger: mcpCtx?.trigger,
      log: (msg: string, meta?: Record<string, unknown>) => {
        console.log(`[mcp/internal/support_inbox/${tool_name}] ${msg}`, meta ?? "");
      },
    };
    const output = await spec.execute(ctx, parsedInput);
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
