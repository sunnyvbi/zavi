
import { listToolsForTenant } from "@/services/mcp/discovery";
import { makeDispatchTool } from "../../engine/dispatch-tool";
import { isToolAllowed } from "@/services/capabilities/registry";
import { evaluateToolCallPolicy } from "../../tool-call-policy";
import { isAgentKilled } from "../../kill-switch";
import { callMcpTool } from "@/services/mcp/execute";
import { isReadOnlyToolName } from "../tool-bridge";
import type { EngineToolCall, EngineToolResult, EngineToolSpec } from "../../engine/types";

export const STUDIO_AGENT_SLUG = process.env.ZAVI_STUDIO_AGENT_SLUG || "performance-marketer";

export type RealFunnelOptions = {
  tenantId: string;
  agentSlug?: string;
  allowWrites?: boolean;
};

export async function buildRealStudioTools(
  tenantId: string,
  agentSlug: string = STUDIO_AGENT_SLUG,
): Promise<EngineToolSpec[]> {
  const { loadGlobalAgentDefinition } = await import("../../registry");
  const def = loadGlobalAgentDefinition(agentSlug);
  const declared = (def?.metadata_praxis?.tools ?? []) as string[];

  const resolved = await listToolsForTenant(tenantId, declared, agentSlug);
  return resolved.map((t) => ({
    name: t.name,
    description: t.description,
    jsonSchema: t.input_schema,
  }));
}

export function makeRealStudioDispatchTool(opts: RealFunnelOptions) {
  const { tenantId, agentSlug = STUDIO_AGENT_SLUG } = opts;
  const allowWrites = opts.allowWrites ?? process.env.ZAVI_STUDIO_ALLOW_WRITES === "1";

  if (allowWrites) {
    console.warn(
      "\n" +
        "  ⚠️  ZAVI_STUDIO_ALLOW_WRITES=1 — write tools are LIVE against tenant\n" +
        `      ${tenantId}. There is no budget cap, no audit row and no approval\n` +
        "      rail on a Studio session. Ctrl-C now if you did not mean this.\n",
    );
  }

  const real = makeDispatchTool({
    isToolAllowed,
    evaluateToolCallPolicy,
    shouldDenyPmOperatorDb: () => false,
    isAgentKilled,
    callMcpTool,
    tenant_id: tenantId,
    agent_slug: agentSlug,
    baseCallCtx: {
      tenant_id: tenantId,
      run_id: `studio-${Date.now()}`,
      agent_slug: agentSlug,
      trigger: "manual",
    } as never,
    onEvent: (e: { type: string; name?: string; ms?: number; code?: string }) => {
      if (e.type === "tool_call") {
        console.log(`[studio/tool] ${e.name} ${e.ms}ms code=${e.code}`);
      }
    },
  } as never);

  return async function dispatchTool(call: EngineToolCall): Promise<EngineToolResult> {
    if (!allowWrites && !isReadOnlyToolName(call.tool_name)) {
      console.log(`[studio/tool] ${call.tool_name} DENIED (read-only mode)`);
      return {
        is_error: true,
        denied: true,
        ms: 0,
        code: "studio_read_only",
        content:
          `DENIED: "${call.tool_name}" is a write tool and this session is read-only. ` +
          "Studio runs have no budget cap, no audit row and no approval rail, so writes " +
          "are blocked. Describe exactly what you would have sent, and continue with reads.",
      };
    }
    return real(call);
  };
}
