
import { serviceClient } from "@/services/supabase";
import { decideOnDecision } from "@/services/approvals/decide-service";
import { logEvent } from "@/services/logging/logEvent";

export async function tenantOwnerId(tenant_id: string): Promise<string | null> {
  const { data: ownerRow } = await serviceClient()
    .from("tenant_users")
    .select("user_id")
    .eq("tenant_id", tenant_id)
    .eq("role", "owner")
    .maybeSingle();
  return (ownerRow as { user_id: string } | null)?.user_id ?? null;
}

export async function approveDecisionAsCgo(
  tenant_id: string,
  decision_id: string,
  decision_class: string,
  log: { code: string; message: string },
): Promise<boolean> {
  try {
    const owner_user_id = await tenantOwnerId(tenant_id);
    if (!owner_user_id) return false;
    const result = await decideOnDecision({ decision_id, tenant_id, action: "approve", actor: { user_id: owner_user_id }, approver_source: "cgo" });
    const approved = result.ok && result.changed;
    await logEvent({
      level: "info",
      source: "cgo-auto-run",
      code: approved ? log.code : `${log.code}_failed`,
      message: log.message,
      tenant_id,
      meta: { decision_class },
    });
    return approved;
  } catch (e) {
    try {
      const { data, error } = await serviceClient()
        .from("decisions")
        .select("status")
        .eq("id", decision_id)
        .eq("tenant_id", tenant_id)
        .maybeSingle();
      if (error) throw error;
      const status = (data as { status?: string } | null)?.status;
      if (status === "dispatching" || status === "acted") return true;
      if (status === "approved") {
        const { inngest } = await import("@/../workers/client");
        await inngest.send({
          id: `approve:${decision_id}`,
          name: "decision.approved",
          data: { decision_id, tenant_id, decision_class },
        });
        return true;
      }
    } catch {
    }
    console.warn(`[cgo-auto-run] ${decision_class} ${decision_id} (tenant ${tenant_id}) left for the founder: ${(e as Error).message}`);
    return false;
  }
}

export async function autoRunCgoCard(tenant_id: string, decision_id: string): Promise<boolean> {
  try {
    const { data, error } = await serviceClient()
      .from("decisions")
      .select("body, decision_class, status")
      .eq("id", decision_id)
      .eq("tenant_id", tenant_id)
      .maybeSingle();
    const row = data as { body?: Record<string, unknown> | null; decision_class?: string; status?: string } | null;
    if (error || !row || row.decision_class !== "cgo.dispatch-specialist" || row.status !== "proposed") return false;
    const { authorizeUnattended, dispatchActionFromBody } = await import("./unattended-policy");
    const v = await authorizeUnattended(tenant_id, dispatchActionFromBody(row.body), { where: "auto_run" });
    if (v.verdict !== "allow") return false;
  } catch (e) {
    console.warn(`[cgo-auto-run] card ${decision_id} (tenant ${tenant_id}) left for the founder: ${(e as Error).message}`);
    return false;
  }
  return approveDecisionAsCgo(tenant_id, decision_id, "cgo.dispatch-specialist", {
    code: "cgo.card_auto_run",
    message: "cgo card approved by cgo (autopilot)",
  });
}
