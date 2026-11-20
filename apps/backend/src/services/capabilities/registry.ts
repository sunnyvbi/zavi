
import { serviceClient } from "@/services/supabase";

export type ToolDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

export async function isToolAllowed(
  tenant_id: string,
  agent_slug: string,
  tool_name: string,
): Promise<ToolDecision> {
  if (!tenant_id || !tool_name) {
    return { allowed: true };
  }

  const { data, error } = await serviceClient()
    .from("tenant_tool_deny")
    .select("agent_slug, reason")
    .eq("tenant_id", tenant_id)
    .eq("tool_name", tool_name)
    .in("agent_slug", [agent_slug, ""])
    .limit(1);

  if (error) {
    console.warn(
      `[capabilities] tenant_tool_deny lookup failed for (${tenant_id}, ${agent_slug}, ${tool_name}): ${error.message}`,
    );
    return { allowed: true };
  }

  if (!data || data.length === 0) {
    return { allowed: true };
  }

  const row = data[0];
  const scope = row.agent_slug === "" ? "tenant-wide" : `agent ${agent_slug}`;
  const reasonText = row.reason
    ? `${row.reason} (scope: ${scope})`
    : `tool denied by tenant policy (scope: ${scope})`;
  return { allowed: false, reason: reasonText };
}
