
import {
  decideEgress,
  decideUntrustedInboundEgress,
  type EgressPolicyDecision,
} from "@/services/mcp/egress-policy";

export interface ToolCallPolicyInput {
  tool_name: string;
  resolved_tool_names: readonly string[];
  research_scoped: boolean;
  agent_slug: string;
  untrusted_inbound: boolean;
  private_data_touched?: boolean;
  tenant_id?: string;
}

export type ToolCallPolicyDecision =
  | { allow: true; reason: "ok" }
  | { allow: false; reason: string; synthetic_tool_result: string };

export function evaluateToolCallPolicy(
  input: ToolCallPolicyInput,
): ToolCallPolicyDecision {
  if (
    input.untrusted_inbound &&
    decideUntrustedInboundEgress(input.tool_name, {
      tenant_id: input.tenant_id,
    }) === "deny"
  ) {
    return {
      allow: false,
      reason: "egress_denied_untrusted_inbound",
      synthetic_tool_result: `EGRESS DENIED: \`${input.tool_name}\` is blocked on this turn because its context contains UNTRUSTED THIRD-PARTY text (inbound email, GitHub webhook, or captured web-page content — D2 zero-click-exfil control).`,
    };
  }

  const bare = input.tool_name.startsWith("mcp__")
    ? input.tool_name.slice("mcp__".length)
    : input.tool_name;
  if (input.untrusted_inbound && bare === "report__render_artifact") {
    return {
      allow: false,
      reason: "egress_denied_untrusted_inbound",
      synthetic_tool_result:
        "PAGE DENIED: `report__render_artifact` is blocked on this turn because its context contains UNTRUSTED THIRD-PARTY text (inbound email, GitHub webhook, or captured web-page content). Answer in chat instead; the person can ask for a page in a normal chat turn.",
    };
  }

  const egress: EgressPolicyDecision = decideEgress({
    tool_name: input.tool_name,
    resolved_tool_names: input.resolved_tool_names,
    research_scoped: input.research_scoped,
    agent_slug: input.agent_slug,
    private_data_touched: input.private_data_touched,
  });
  if (!egress.allow) {
    return {
      allow: false,
      reason: egress.reason,
      synthetic_tool_result: egress.synthetic_tool_result,
    };
  }

  return { allow: true, reason: "ok" };
}
