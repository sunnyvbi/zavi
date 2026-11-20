
import type { AgentContext } from "@/services/agents/types";
import { makeDraftCtx } from "@/services/agents/generic-dispatcher";

export function makeDoneForYouCtx(ctx: AgentContext): AgentContext {
  return { ...makeDraftCtx(ctx), done_for_you: true };
}
