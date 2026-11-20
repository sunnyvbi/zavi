
import type { McpCallResult, McpTool } from "../types";
import type { CallMcpContext } from "../execute";
import {
  investorDiscoverySearchTool,
  runInvestorDiscovery,
} from "@/services/tools/investor-discovery/search";
import { ExpectedToolError } from "@/services/tools/types";
import { zodToJsonSchema } from "@/services/tools/registry";

const TOOLS = [investorDiscoverySearchTool];

export function listInvestorDiscoveryTools(): McpTool[] {
  return TOOLS.map((t) => {
    const schema = zodToJsonSchema(t.input_schema);
    if (schema.type !== "object") {
      throw new Error(`Tool ${t.name} must be a top-level z.object()`);
    }
    const tool_name = t.name.replace(/^investor_discovery_/, "");
    return {
      server_id: "investor_discovery",
      tool_name,
      description: t.description,
      effect: t.effect,
      input_schema: schema as { type: "object"; [k: string]: unknown },
    };
  });
}

export async function callInvestorDiscoveryTool(
  ctx: CallMcpContext,
  tool_name: string,
  args: unknown,
): Promise<McpCallResult> {
  const start = Date.now();
  if (tool_name !== "search") {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({
        error: "tool_unknown",
        message: `investor_discovery/${tool_name} not registered`,
      }),
      ms: Date.now() - start,
    };
  }
  try {
    const output = await runInvestorDiscovery(ctx, args);
    return { ok: true, is_error: false, content: JSON.stringify(output), ms: Date.now() - start };
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
    if ((e as { name?: string })?.name === "ZodError") {
      return {
        ok: false,
        is_error: true,
        content: JSON.stringify({ error: "tool_input_invalid", message: (e as Error).message }),
        ms: Date.now() - start,
      };
    }
    throw e;
  }
}
