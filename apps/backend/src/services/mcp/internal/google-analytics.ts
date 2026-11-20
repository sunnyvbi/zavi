
import type { McpCallResult, McpTool } from "../types";
import { gaRunReportTool } from "@/services/tools/google-analytics/run_report";
import { ExpectedToolError } from "@/services/tools/types";
import { honestComposioToolError } from "@/services/connectors/composio/account";
import { zodToJsonSchema } from "@/services/tools/registry";

const TOOLS = [gaRunReportTool];

export function listGoogleAnalyticsTools(): McpTool[] {
  return TOOLS.map((t) => {
    const schema = zodToJsonSchema(t.input_schema);
    if (schema.type !== "object") {
      throw new Error(`Tool ${t.name} must be a top-level z.object()`);
    }
    const tool_name = t.name.replace(/^google_analytics_/, "");
    return {
      server_id: "google_analytics",
      tool_name,
      description: t.description,
      effect: t.effect,
      input_schema: schema as { type: "object"; [k: string]: unknown },
    };
  });
}

export type GoogleAnalyticsToolCtx = {
  tenant_id: string;
};

export async function callGoogleAnalyticsTool(
  ctx: GoogleAnalyticsToolCtx,
  tool_name: string,
  args: unknown,
): Promise<McpCallResult> {
  const start = Date.now();
  const legacyName = `google_analytics_${tool_name}`;
  const spec = TOOLS.find((t) => t.name === legacyName);
  if (!spec) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: "tool_unknown", message: `google_analytics/${tool_name} not registered` }),
      ms: Date.now() - start,
    };
  }
  try {
    const parsedInput = spec.input_schema.parse(args);
    const toolCtx = {
      tenant_id: ctx.tenant_id,
      log: (msg: string, meta?: Record<string, unknown>) => {
        console.log(`[mcp/internal/google_analytics/${tool_name}] ${msg}`, meta ?? "");
      },
    };
    const output = await spec.execute(toolCtx, parsedInput);
    return { ok: true, is_error: false, content: JSON.stringify(output), ms: Date.now() - start };
  } catch (thrown) {
    const e = await honestComposioToolError(ctx.tenant_id, "google_analytics", "Google Analytics", thrown);
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
