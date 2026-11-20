
import type { McpCallResult, McpTool } from "../types";
import { spotifyAdsListAccountsTool } from "@/services/tools/spotify-ads/list_accounts";
import { spotifyAdsListCampaignsTool } from "@/services/tools/spotify-ads/list_campaigns";
import { ExpectedToolError } from "@/services/tools/types";
import { zodToJsonSchema } from "@/services/tools/registry";

const TOOLS = [spotifyAdsListAccountsTool, spotifyAdsListCampaignsTool];

export function listSpotifyAdsTools(): McpTool[] {
  return TOOLS.map((t) => {
    const schema = zodToJsonSchema(t.input_schema);
    if (schema.type !== "object") throw new Error(`Tool ${t.name} must be a top-level z.object()`);
    return {
      server_id: "spotify_ads",
      tool_name: t.name.replace(/^spotify_ads_/, ""),
      description: t.description,
      effect: t.effect,
      input_schema: schema as { type: "object"; [k: string]: unknown },
    };
  });
}

export async function callSpotifyAdsTool(
  ctx: { tenant_id: string },
  tool_name: string,
  args: unknown,
): Promise<McpCallResult> {
  const start = Date.now();
  const spec = TOOLS.find((t) => t.name === `spotify_ads_${tool_name}`);
  if (!spec) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: "tool_unknown", message: `spotify_ads/${tool_name} not registered` }),
      ms: Date.now() - start,
    };
  }
  try {
    const parsedInput = spec.input_schema.parse(args);
    const output = await spec.execute(
      {
        tenant_id: ctx.tenant_id,
        log: (msg: string, meta?: Record<string, unknown>) => {
          console.log(`[mcp/internal/spotify-ads/${tool_name}] ${msg}`, meta ?? "");
        },
      },
      parsedInput,
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
