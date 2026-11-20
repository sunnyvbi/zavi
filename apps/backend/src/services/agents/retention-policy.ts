
import { serviceClient } from "@/services/supabase";

export async function shouldStoreRawTranscripts(
  run_id: string,
): Promise<boolean> {
  try {
    const { data: run, error: runErr } = await serviceClient()
      .from("agent_runs")
      .select("tenant_id")
      .eq("id", run_id)
      .maybeSingle();
    if (runErr) return false;
    const tenantId = (run as { tenant_id?: string } | null)?.tenant_id;
    if (!tenantId) return false;

    const { data, error } = await serviceClient()
      .from("tenant_retention_policy")
      .select("store_raw")
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (error) return false;
    return (data as { store_raw?: boolean } | null)?.store_raw ?? true;
  } catch {
    return false;
  }
}
