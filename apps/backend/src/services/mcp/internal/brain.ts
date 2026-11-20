
import type { McpCallResult, McpTool } from "../types";
import { brainRefineAnchorTool } from "@/services/tools/memory/refine-anchor";
import { brainApplyAnchorTool } from "@/services/tools/memory/apply-anchor";
import { brainRetireNoteTool } from "@/services/tools/memory/retire-note";
import { ExpectedToolError } from "@/services/tools/types";
import { zodToJsonSchema } from "@/services/tools/registry";

const TOOLS = [brainRefineAnchorTool, brainApplyAnchorTool, brainRetireNoteTool];

export function listBrainTools(): McpTool[] {
  return TOOLS.map((t) => {
    const schema = zodToJsonSchema(t.input_schema);
    if (schema.type !== "object") {
      throw new Error(`Tool ${t.name} must be a top-level z.object()`);
    }
    const tool_name = t.name.replace(/^brain_/, "");
    return {
      server_id: "brain",
      tool_name,
      description: t.description,
      effect: t.effect,
      input_schema: schema as { type: "object"; [k: string]: unknown },
    };
  });
}

export async function callBrainTool(
  tenant_id: string,
  tool_name: string,
  args: unknown,
  identity?: {
    run_id?: string;
    agent_slug?: string;
    run_trigger?: string;
    untrusted_context?: boolean;
    captured_page_context?: boolean;
    chat_thread_id?: string;
  },
): Promise<McpCallResult> {
  const start = Date.now();
  const legacyName = `brain_${tool_name}`;
  const spec = TOOLS.find((t) => t.name === legacyName);
  if (!spec) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: "tool_unknown", message: `brain/${tool_name} not registered` }),
      ms: Date.now() - start,
    };
  }
  try {
    const parsedInput = spec.input_schema.parse(args);
    const ctx = {
      tenant_id,
      run_id: identity?.run_id,
      agent_slug: identity?.agent_slug,
      run_trigger: identity?.run_trigger,
      untrusted_context: identity?.untrusted_context,
      captured_page_context: identity?.captured_page_context,
      chat_thread_id: identity?.chat_thread_id,
      log: (msg: string, meta?: Record<string, unknown>) => {
        console.log(`[mcp/internal/brain/${tool_name}] ${msg}`, meta ?? "");
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
