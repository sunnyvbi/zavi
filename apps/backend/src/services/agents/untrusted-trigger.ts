
import type { AgentTrigger } from "./types";

export const UNTRUSTED_INBOUND_TRIGGERS: ReadonlySet<AgentTrigger> = new Set([
  "email",
  "webhook",
] as const);

export function untrustedInboundWidenEnabled(): boolean {
  return process.env.UNTRUSTED_INBOUND_TRIGGER_WIDEN !== "0";
}

export function isUntrustedInboundTrigger(
  trigger: string | null | undefined,
): boolean {
  if (trigger == null) return false;
  if (!untrustedInboundWidenEnabled()) {
    return trigger === "email";
  }
  return (UNTRUSTED_INBOUND_TRIGGERS as ReadonlySet<string>).has(trigger);
}

export function untrustedContextEgressDenyEnabled(): boolean {
  return process.env.UNTRUSTED_CONTEXT_EGRESS_DENY !== "0";
}

export function isUntrustedInboundRun(ctx: {
  trigger?: string | null;
  untrusted_context?: boolean;
}): boolean {
  if (isUntrustedInboundTrigger(ctx.trigger)) return true;
  return untrustedContextEgressDenyEnabled() && ctx.untrusted_context === true;
}
