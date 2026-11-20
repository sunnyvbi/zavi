import type { McpCallResult, McpTool } from "../types";
import { zodToJsonSchema } from "@/services/tools/registry";
import { ExpectedToolError } from "@/services/tools/types";
import { TIKTOK_TOOLS } from "@/services/tools/tiktok/tools";
import type { ActorAuthorityEnvelopeV1 } from "@/services/agents/actor-envelope";

export function listTikTokTools(): McpTool[] {
  return TIKTOK_TOOLS.map((tool) => ({
    server_id: "tiktok",
    tool_name: tool.name.replace(/^tiktok_/, ""),
    description: tool.description,
    effect: tool.effect,
    input_schema: zodToJsonSchema(tool.input_schema) as { type: "object"; [k: string]: unknown },
  }));
}

export async function callTikTokTool(
  ctx: { tenant_id: string; run_trigger?: string; actor?: ActorAuthorityEnvelopeV1; writes_suppressed?: boolean },
  tool_name: string,
  args: unknown,
): Promise<McpCallResult> {
  const start = Date.now();
  const tool = TIKTOK_TOOLS.find((t) => t.name === `tiktok_${tool_name}`);
  if (!tool) return { ok: false, is_error: true, content: JSON.stringify({ error: "tool_unknown" }), ms: Date.now() - start };
  try {
    const input = tool.input_schema.parse(args);
    const output = await tool.execute({ tenant_id: ctx.tenant_id, run_trigger: ctx.run_trigger, actor: ctx.actor, log: () => {}, ...(ctx.writes_suppressed ? { writes_suppressed: true } : {}) }, input);
    return { ok: true, is_error: false, content: JSON.stringify(output), ms: Date.now() - start };
  } catch (e) {
    if (e instanceof ExpectedToolError) return { ok: false, is_error: true, content: JSON.stringify({ error: e.code, message: e.message, ...(e.meta ? { meta: e.meta } : {}) }), ms: Date.now() - start };
    throw e;
  }
}
