
import { serviceClient } from "@/services/supabase";
import { logEvent } from "@/services/logging/logEvent";

export type DecisionRejectionType =
  | "autonomy_forbidden"
  | "dedup_suppressed_24h"
  | "cap_exceeded"
  | "condition_unmet"
  | "founder_override"
  | "agent_not_emitted";

export type LogDecisionNotTakenInput = {
  tenant_id: string;
  rejection_type: DecisionRejectionType;
  agent_run_id?: string | null;
  agent_slug?: string | null;
  decision_class?: string | null;
  reason_code?: string | null;
};

export type LogDecisionNotTakenDeps = {
  insert: (row: Record<string, unknown>) => Promise<void>;
};

const realDeps: LogDecisionNotTakenDeps = {
  async insert(row) {
    const { error } = await serviceClient().from("agent_decisions_not_taken").insert(row);
    if (error) throw new Error(error.message);
  },
};

export async function logDecisionNotTaken(
  input: LogDecisionNotTakenInput,
  deps: LogDecisionNotTakenDeps = realDeps,
): Promise<boolean> {
  try {
    await deps.insert({
      tenant_id: input.tenant_id,
      rejection_type: input.rejection_type,
      agent_run_id: input.agent_run_id ?? null,
      agent_slug: input.agent_slug ?? null,
      decision_class: input.decision_class ?? null,
      reason_code: input.reason_code ?? null,
    });
    return true;
  } catch (e) {
    await logEvent({
      level: "warn",
      source: "agents.decision-not-taken",
      code: "log_decision_not_taken_failopen",
      tenant_id: input.tenant_id,
      error: e instanceof Error ? e : new Error(String(e)),
    }).catch(() => {});
    return false;
  }
}
