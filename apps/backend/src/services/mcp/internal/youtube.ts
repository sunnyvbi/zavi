
import type { McpCallResult, McpTool } from "../types";
import { youtubeSearchVideosTool } from "@/services/tools/youtube/search_videos";
import { youtubeVideoStatsTool } from "@/services/tools/youtube/video_stats";
import { youtubeChannelStatsTool } from "@/services/tools/youtube/channel_stats";
import { ExpectedToolError } from "@/services/tools/types";
import { zodToJsonSchema } from "@/services/tools/registry";

const TOOLS = [youtubeSearchVideosTool, youtubeVideoStatsTool, youtubeChannelStatsTool];

export function listYoutubeTools(): McpTool[] {
  return TOOLS.map((t) => {
    const schema = zodToJsonSchema(t.input_schema);
    if (schema.type !== "object") {
      throw new Error(`Tool ${t.name} must be a top-level z.object()`);
    }
    const tool_name = t.name.replace(/^youtube_/, "");
    return {
      server_id: "youtube",
      tool_name,
      description: t.description,
      effect: t.effect,
      input_schema: schema as { type: "object"; [k: string]: unknown },
    };
  });
}

export async function callYoutubeTool(
  tenant_id: string,
  tool_name: string,
  args: unknown,
  run_id?: string | null,
): Promise<McpCallResult> {
  const start = Date.now();
  const legacyName = `youtube_${tool_name}`;
  const spec = TOOLS.find((t) => t.name === legacyName);
  if (!spec) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({
        error: "tool_unknown",
        message: `youtube/${tool_name} not registered`,
      }),
      ms: Date.now() - start,
    };
  }
  try {
    const parsedInput = spec.input_schema.parse(args);
    const toolCtx = {
      tenant_id,
      run_id: run_id ?? undefined,
      log: (msg: string, meta?: Record<string, unknown>) => {
        console.log(`[mcp/internal/youtube/${tool_name}] ${msg}`, meta ?? "");
      },
    };
    const output = await spec.execute(toolCtx, parsedInput);
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
    throw e;
  }
}
