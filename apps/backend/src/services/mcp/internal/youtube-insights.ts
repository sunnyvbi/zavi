
import type { McpCallResult, McpTool } from "../types";
import { youtubeInsightsReadTool } from "@/services/tools/youtube-insights/read";
import { ExpectedToolError } from "@/services/tools/types";
import { zodToJsonSchema } from "@/services/tools/registry";

const TOOLS = [youtubeInsightsReadTool];

export function listYoutubeInsightsTools(): McpTool[] {
  return TOOLS.map((t) => {
    const schema = zodToJsonSchema(t.input_schema);
    if (schema.type !== "object") throw new Error(`Tool ${t.name} must be a top-level z.object()`);
    return {
      server_id: "youtube_insights",
      tool_name: t.name.replace(/^youtube_insights_/, ""),
      description: t.description,
      effect: t.effect,
      input_schema: schema as { type: "object"; [k: string]: unknown },
    };
  });
}

export async function callYoutubeInsightsTool(ctx: { tenant_id: string }, tool_name: string, args: unknown): Promise<McpCallResult> {
  const start = Date.now();
  const spec = TOOLS.find((t) => t.name === `youtube_insights_${tool_name}`);
  if (!spec) {
    return { ok: false, is_error: true, content: JSON.stringify({ error: "tool_unknown", message: `youtube_insights/${tool_name} not registered` }), ms: Date.now() - start };
  }
  try {
    const output = await spec.execute(
      { tenant_id: ctx.tenant_id, log: (msg: string, meta?: Record<string, unknown>) => console.log(`[mcp/internal/youtube_insights/${tool_name}] ${msg}`, meta ?? "") } as never,
      spec.input_schema.parse(args),
    );
    return { ok: true, is_error: false, content: JSON.stringify(output), ms: Date.now() - start };
  } catch (e) {
    if (e instanceof ExpectedToolError) {
      return { ok: false, is_error: true, content: JSON.stringify({ error: e.code, message: e.message, ...(e.meta ? { meta: e.meta } : {}) }), ms: Date.now() - start };
    }
    throw e;
  }
}
