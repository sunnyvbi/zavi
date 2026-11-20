
import type { McpCallResult, McpTool } from "../types";
import { gsListTabsTool } from "@/services/tools/google-sheets/list_tabs";
import { gsReadRangeTool } from "@/services/tools/google-sheets/read_range";
import { ExpectedToolError } from "@/services/tools/types";
import { zodToJsonSchema } from "@/services/tools/registry";

const TOOLS = [gsListTabsTool, gsReadRangeTool];

export function listGoogleSheetsTools(): McpTool[] {
  return TOOLS.map((t) => {
    const schema = zodToJsonSchema(t.input_schema);
    if (schema.type !== "object") {
      throw new Error(`Tool ${t.name} must be a top-level z.object()`);
    }
    const tool_name = t.name.replace(/^google_sheets_/, "");
    return {
      server_id: "google_sheets",
      tool_name,
      description: t.description,
      effect: t.effect,
      input_schema: schema as { type: "object"; [k: string]: unknown },
    };
  });
}

export type GoogleSheetsToolCtx = {
  tenant_id: string;
};

export async function callGoogleSheetsTool(
  ctx: GoogleSheetsToolCtx,
  tool_name: string,
  args: unknown,
): Promise<McpCallResult> {
  const start = Date.now();
  const legacyName = `google_sheets_${tool_name}`;
  const spec = TOOLS.find((t) => t.name === legacyName);
  if (!spec) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: "tool_unknown", message: `google_sheets/${tool_name} not registered` }),
      ms: Date.now() - start,
    };
  }
  try {
    const parsedInput = spec.input_schema.parse(args);
    const toolCtx = {
      tenant_id: ctx.tenant_id,
      log: (msg: string, meta?: Record<string, unknown>) => {
        console.log(`[mcp/internal/google_sheets/${tool_name}] ${msg}`, meta ?? "");
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
