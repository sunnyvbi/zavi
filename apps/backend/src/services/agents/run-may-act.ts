
import { asTenantId, tenantClient } from "@/services/tenant-client";

export async function runMayActNow(tenant_id: string, run_id: string): Promise<boolean> {
  try {
    const db = tenantClient(asTenantId(tenant_id));
    const { data: run, error } = await db
      .from("agent_runs")
      .select("stop_requested, agent_slug")
      .eq("id", run_id)
      .maybeSingle();
    if (error || !run) return false;
    const r = run as { stop_requested?: boolean | null; agent_slug?: string | null };
    if (r.stop_requested === true) return false;
    if (typeof r.agent_slug === "string" && r.agent_slug) {
      const { data: kill, error: killError } = await db
        .from("tenant_agent_kill_switch")
        .select("agent_slug")
        .eq("agent_slug", r.agent_slug)
        .eq("override_state", "hidden")
        .eq("source", "staff")
        .maybeSingle();
      if (killError || kill) return false;
    }
    return true;
  } catch {
    return false;
  }
}
