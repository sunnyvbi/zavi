
import type { McpCallResult, McpTool } from "../types";
import { memorySearchTool } from "@/services/tools/memory/search";
import { memoryWriteTool } from "@/services/tools/memory/write";
import {
  agenticReadTools,
  isAgenticReadEnabledForTenant,
} from "@/services/tools/memory/agentic-read";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { zodToJsonSchema } from "@/services/tools/registry";

const BASE_TOOLS = [memorySearchTool, memoryWriteTool];

function toolsForFlag(enabled: boolean): ToolSpec[] {
  return enabled ? [...BASE_TOOLS, ...agenticReadTools] : BASE_TOOLS;
}

export async function listMemoryTools(tenant_id: string): Promise<McpTool[]> {
  const enabled = await isAgenticReadEnabledForTenant(tenant_id);
  return listMemoryToolsForFlag(enabled);
}

export function listMemoryToolsForFlag(enabled: boolean): McpTool[] {
  return toolsForFlag(enabled).map((t) => {
    const schema = zodToJsonSchema(t.input_schema);
    if (schema.type !== "object") {
      throw new Error(`Tool ${t.name} must be a top-level z.object()`);
    }
    const tool_name = t.name.replace(/^memory_/, "");
    return {
      server_id: "memory",
      tool_name,
      description: t.description,
      effect: t.effect,
      input_schema: schema as { type: "object"; [k: string]: unknown },
    };
  });
}

export async function callMemoryTool(
  tenant_id: string,
  tool_name: string,
  args: unknown,
  identity?: { run_id?: string; agent_slug?: string },
): Promise<McpCallResult> {
  const start = Date.now();
  const legacyName = `memory_${tool_name}`;
  const enabled = await isAgenticReadEnabledForTenant(tenant_id);
  const TOOLS = toolsForFlag(enabled);
  const spec = TOOLS.find((t) => t.name === legacyName);
  if (!spec) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: "tool_unknown", message: `memory/${tool_name} not registered` }),
      ms: Date.now() - start,
    };
  }
  try {
    const parsedInput = spec.input_schema.parse(args);
    const ctx = {
      tenant_id,
      run_id: identity?.run_id,
      agent_slug: identity?.agent_slug,
      log: (msg: string, meta?: Record<string, unknown>) => {
        console.log(`[mcp/internal/memory/${tool_name}] ${msg}`, meta ?? "");
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
