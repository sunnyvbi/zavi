
import { buildConductorRunIdOf } from "@/services/billing/tiers";
import type { AgentTrigger } from "@/services/agents/types";

export function isBuildStepRun(trigger: AgentTrigger | string | null | undefined, payload: unknown): boolean {
  if (trigger !== "a2a") return false;
  if (buildConductorRunIdOf(payload) !== null) return true;
  return (payload as { stage?: unknown } | null | undefined)?.stage === "qa";
}
