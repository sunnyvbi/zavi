import type { ToolContext } from "@/services/tools/types";
import type { GatewayContext } from "@/services/data-gateway/types";

export function gatewayCtx(ctx: ToolContext, tool_name: string): GatewayContext {
  if (ctx.gateway && ctx.gateway.tenant_id === ctx.tenant_id) return ctx.gateway;
  return {
    tenant_id: ctx.tenant_id,
    caller: { kind: "agent", agent_slug: ctx.agent_slug ?? null, run_id: ctx.run_id ?? null, tool_name },
  };
}
