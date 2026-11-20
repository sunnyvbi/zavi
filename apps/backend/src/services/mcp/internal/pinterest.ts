
import type { McpCallResult, McpTool } from "../types";
import { pinterestPublicPinsTool } from "@/services/tools/pinterest/public_pins";
import { pinterestSiteReadinessTool } from "@/services/tools/pinterest/site_readiness";
import { ExpectedToolError } from "@/services/tools/types";
import { zodToJsonSchema } from "@/services/tools/registry";

const TOOLS = [pinterestPublicPinsTool, pinterestSiteReadinessTool];

export function listPinterestTools(): McpTool[] {
  return TOOLS.map((t) => {
    const schema = zodToJsonSchema(t.input_schema);
    if (schema.type !== "object") {
      throw new Error(`Tool ${t.name} must be a top-level z.object()`);
    }
    return {
      server_id: "pinterest",
      tool_name: t.name.replace(/^pinterest_/, ""),
      description: t.description,
      effect: t.effect,
      input_schema: schema as { type: "object"; [k: string]: unknown },
    };
  });
}

export async function callPinterestTool(
  tenant_id: string,
  tool_name: string,
  args: unknown,
): Promise<McpCallResult> {
  const start = Date.now();
  const spec = TOOLS.find((t) => t.name.replace(/^pinterest_/, "") === tool_name);
  if (!spec) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: "tool_unknown", message: `pinterest/${tool_name} not registered` }),
      ms: Date.now() - start,
    };
  }
  try {
    const out = await spec.execute({ tenant_id } as never, args);
    return { ok: true, is_error: false, content: JSON.stringify(out), ms: Date.now() - start };
  } catch (e) {
    if (e instanceof ExpectedToolError) {
      return {
        ok: false,
        is_error: true,
        content: JSON.stringify({ error: e.code, message: e.message }),
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
