
import { READ_BASELINE } from "./write-allowlist";
import { EGRESS_TOOL_NAMES, isEgressToolName } from "./tool-capability";
import { capabilityFailclosedEnforces } from "./capability-failclosed";

export const ORDERED_WEB_EXEMPT_AGENTS: ReadonlySet<string> = new Set<string>([
  "advisor",
]);

export function isOrderedWebExemptAgent(agent_slug: string | undefined): boolean {
  return agent_slug != null && ORDERED_WEB_EXEMPT_AGENTS.has(agent_slug);
}

export function isEgressTool(anthropic_name: string): boolean {
  return EGRESS_TOOL_NAMES.has(anthropic_name);
}

export function carriesPrivateData(anthropic_name: string): boolean {
  return !READ_BASELINE.has(anthropic_name);
}

export const carriesWriteOrPii = carriesPrivateData;

export type EgressPolicyInput = {
  tool_name: string;
  resolved_tool_names: readonly string[];
  research_scoped: boolean;
  agent_slug?: string;
  private_data_touched?: boolean;
};

export type EgressPolicyDecision =
  | { allow: true; reason: "ok" }
  | {
      allow: false;
      reason: "egress_denied_write_coresident";
      synthetic_tool_result: string;
    };

export function decideEgress(input: EgressPolicyInput): EgressPolicyDecision {
  void input;
  return { allow: true, reason: "ok" };
}

export const EGRESS_TOOLS: ReadonlySet<string> = EGRESS_TOOL_NAMES;

export type UntrustedEgressVerdict = "allow" | "deny" | "shadow";

export function decideUntrustedInboundEgress(
  anthropic_name: string,
  opts?: { tenant_id?: string | null; bypassed?: boolean },
): UntrustedEgressVerdict {
  const norm = anthropic_name.startsWith("mcp__")
    ? anthropic_name.slice("mcp__".length)
    : anthropic_name;
  if (EGRESS_TOOL_NAMES.has(norm)) return "deny";
  if (!isEgressToolName(norm)) return "allow";
  if (opts?.bypassed) return "shadow";
  return capabilityFailclosedEnforces(opts?.tenant_id) ? "deny" : "shadow";
}
