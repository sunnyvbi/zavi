
import { serviceClient } from "../supabase";

export async function isAgentKilled(tenant_id: string, agent_slug: string): Promise<boolean> {
  try {
    const { data, error } = await serviceClient()
      .from("tenant_agent_kill_switch")
      .select("agent_slug")
      .eq("tenant_id", tenant_id)
      .eq("agent_slug", agent_slug)
      .eq("override_state", "hidden")
      .eq("source", "staff")
      .maybeSingle();
    if (error) {
      console.warn(`[kill-switch] isAgentKilled lookup failed for ${agent_slug}: ${error.message}`);
      return false;
    }
    return !!data;
  } catch (e) {
    console.warn(`[kill-switch] isAgentKilled threw for ${agent_slug}: ${(e as Error).message}`);
    return false;
  }
}
