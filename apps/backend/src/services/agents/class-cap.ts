
import { serviceClient } from "@/services/supabase";
import { DECISION_CLASS } from "@/services/agents/autopilot-pipeline-contract";

export type ClassCapDecision = "charged" | "over_cap" | "read_error";

export function decisionClassForStage(stage: string | null | undefined): string | null {
  if (typeof stage !== "string" || stage.length === 0) return null;
  if (stage === "provision") return DECISION_CLASS.PROVISION_REPO;
  if (stage === "spec" || stage === "scaffold" || stage === "build" || stage === "qa") {
    return stage;
  }
  return null;
}

export async function consumeClassBudget(
  tenant_id: string,
  decision_class: string,
  estimate_usd: number,
): Promise<ClassCapDecision> {
  try {
    const { data, error } = await serviceClient().rpc("consume_class_budget_or_reject", {
      p_tenant_id: tenant_id,
      p_decision_class: decision_class,
      p_estimate_usd: estimate_usd,
    });
    if (error) {
      console.warn(
        `[class-cap] consume_class_budget_or_reject failed for ${tenant_id}/${decision_class}: ${error.message} — read_error (transient, retry)`,
      );
      return "read_error";
    }
    return data === "charged" ? "charged" : "over_cap";
  } catch (e) {
    console.warn(
      `[class-cap] consume_class_budget_or_reject threw for ${tenant_id}/${decision_class}: ${(e as Error).message} — read_error (transient, retry)`,
    );
    return "read_error";
  }
}
