
import { serviceClient } from "@/services/supabase";

export const GROUNDING_PRIMARY_MATCH = "pixel_health";
export const GROUNDING_SECONDARY_MATCHES = [
  "read_cohort",
  "diagnose_funnel",
  "read_verified_bookings_by_campaign",
] as const;

export function hasGroundingTools(toolNames: Iterable<string>): boolean {
  const names = [...toolNames].map((n) => String(n).toLowerCase());
  const pixel = names.some((n) => n.includes(GROUNDING_PRIMARY_MATCH));
  const secondary = names.some((n) =>
    GROUNDING_SECONDARY_MATCHES.some((s) => n.includes(s)),
  );
  return pixel && secondary;
}

export type GroundingContractResult = {
  grounding_contract_failed: boolean;
  route_to_approval: boolean;
  reason: string | null;
};

export function evaluateGroundingContract(input: {
  recommendedAction: boolean;
  groundingToolsCalled: boolean;
}): GroundingContractResult {
  if (!input.recommendedAction || input.groundingToolsCalled) {
    return { grounding_contract_failed: false, route_to_approval: false, reason: null };
  }
  return {
    grounding_contract_failed: true,
    route_to_approval: true,
    reason: "scale_raise_cut_without_grounding_tools",
  };
}

export async function readRunToolNamesFromEvents(
  tenant_id: string,
  run_id?: string,
): Promise<string[] | null> {
  if (!run_id) return null;
  try {
    const { data, error } = await serviceClient()
      .from("agent_run_events")
      .select("meta")
      .eq("agent_run_id", run_id)
      .eq("tenant_id", tenant_id)
      .in("stage", ["tool_use_started", "tool_use_completed"]);
    if (error || !Array.isArray(data)) return null;
    const names: string[] = [];
    for (const row of data) {
      const tn = (row as { meta?: { tool_name?: unknown } } | null)?.meta?.tool_name;
      if (typeof tn === "string" && tn.length > 0) names.push(tn);
    }
    return names;
  } catch {
    return null;
  }
}
