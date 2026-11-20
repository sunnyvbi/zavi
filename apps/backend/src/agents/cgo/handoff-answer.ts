
import { hasInternalJargon } from "@/services/agents/internal-jargon";

const STRATEGY_JOB_STAGES: ReadonlySet<string> = new Set(["draft_strategy", "own_goals"]);

const HANDOFF_CHILD_FLAGS = ["handoff_child", "slack_handoff_child", "whatsapp_handoff_child", "conversation_answer"] as const;

export function isCgoHandoffAnswer(agent_slug: string | null | undefined, trigger: string | null | undefined, payload: unknown): boolean {
  if (agent_slug !== "cgo") return false;
  const p = payload as Record<string, unknown> | null | undefined;
  const surfaceChild = HANDOFF_CHILD_FLAGS.some((k) => p?.[k] === true);
  if (trigger !== "handoff" && !surfaceChild) return false;
  const stage = p?.stage;
  return !(typeof stage === "string" && STRATEGY_JOB_STAGES.has(stage));
}

export const CGO_NO_USABLE_ANSWER =
  "Your CGO couldn't put together a usable answer this time. Ask again and it will try once more.";

export function cgoHandoffReplyBody(text: string | null | undefined): string | null {
  if (typeof text !== "string") return null;
  const kept = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !hasInternalJargon(p));
  return kept.length > 0 ? kept.join("\n\n") : null;
}
