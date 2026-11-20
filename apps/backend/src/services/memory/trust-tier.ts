
import { NEVER_DISTILL } from "../agents/should-distill";

export type TrustTier = 0 | 1 | 2 | 3;

export function trustTierFor(input: {
  trigger: string;
  agent_slug: string;
  untrusted_context?: boolean;
}): TrustTier {
  const { trigger, agent_slug, untrusted_context } = input;

  if (NEVER_DISTILL.has(agent_slug)) return 3;

  if (trigger === "chat") return untrusted_context === true ? 2 : 0;

  if (trigger === "mcp" || trigger === "cron" || trigger === "webhook") return 1;

  return 2;
}
