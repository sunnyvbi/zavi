
import { serviceClient } from "@/services/supabase";

export type ClaimedDecisionRow = {
  id: string;
  tenant_id: string;
  agent_run_id: string | null;
  decision_class: string;
  body: Record<string, unknown>;
  handler: string | null;
  status: string;
  approved_by: string | null;
  approved_by_source: string | null;
};

export async function claimDecision(
  decision_id: string,
): Promise<ClaimedDecisionRow | null> {
  const sb = serviceClient();
  const { data, error } = await sb
    .from("decisions")
    .update({ status: "dispatching", dispatched_at: new Date().toISOString() })
    .eq("id", decision_id)
    .in("status", ["approved", "proposed"])
    .select(
      "id, tenant_id, agent_run_id, decision_class, body, handler, status, approved_by, approved_by_source",
    )
    .maybeSingle();
  if (error) {
    throw new Error(`claimDecision(${decision_id}) failed: ${error.message}`);
  }
  return (data ?? null) as ClaimedDecisionRow | null;
}

export async function markDispatched(decision_id: string): Promise<void> {
  const sb = serviceClient();
  const { error } = await sb
    .from("decisions")
    .update({ status: "acted" })
    .eq("id", decision_id)
    .eq("status", "dispatching");
  if (error) {
    console.warn(`markDispatched(${decision_id}) failed: ${error.message}`);
  }
}

export async function releaseClaim(
  decision_id: string,
  dispatch_error: string,
): Promise<void> {
  const sb = serviceClient();
  const { error } = await sb
    .from("decisions")
    .update({ status: "proposed", dispatch_error })
    .eq("id", decision_id)
    .eq("status", "dispatching");
  if (error) {
    console.warn(`releaseClaim(${decision_id}) failed: ${error.message}`);
  }
}
