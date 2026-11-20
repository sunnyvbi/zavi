
import { asTenantId, tenantClient } from "@/services/tenant-client";

export async function isBudgetBrakeRun(tenant_id: string, run_id?: string | null): Promise<boolean> {
  if (!run_id) return false;
  try {
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("agent_runs")
      .select("payload")
      .eq("id", run_id)
      .maybeSingle();
    if (error || !data) return false;
    const payload = (data as { payload?: unknown }).payload;
    return !!payload && typeof payload === "object" && (payload as { brake?: unknown }).brake === true;
  } catch {
    return false;
  }
}
