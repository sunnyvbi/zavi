
import { logEvent } from "@/services/logging/logEvent";

export type HandoffIntentInput = {
  tenant_id: string;
  source_agent_slug: string | null;
  target_agent_slug: string | null;
  surface: string;
  authorized: boolean;
  reject_reason?: string | null;
  run_id?: string | null;
};

function loggingEnabled(): boolean {
  return process.env.HANDOFF_INTENT_LOGGING !== "0";
}

export async function logHandoffIntent(input: HandoffIntentInput): Promise<void> {
  if (!loggingEnabled()) return;
  try {
    await logEvent({
      level: "info",
      source: "handoff_intent",
      code: "handoff.intent",
      tenant_id: input.tenant_id,
      run_id: input.run_id ?? null,
      meta: {
        agent_slug: input.source_agent_slug ?? "unknown",
        target_agent_slug: input.target_agent_slug ?? "unknown",
        surface: input.surface,
        authorized: input.authorized ? 1 : 0,
        ...(input.reject_reason ? { reject_reason: input.reject_reason } : {}),
      },
    });
  } catch {
  }
}
