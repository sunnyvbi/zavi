
import type { SupabaseClient } from "@supabase/supabase-js";

type RoleRow = { role: string };
type AgentRunMembershipRow = { tenant_id: string };

export async function tenantRoleOf(
  client: SupabaseClient,
  userId: string,
  tenantId: string,
): Promise<string | null> {
  if (!userId || !tenantId) return null;
  const { data, error } = await client
    .from("tenant_users")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .maybeSingle<RoleRow>();
  if (error || !data) return null;
  return data.role;
}

export async function isTenantAdminOrOwner(
  client: SupabaseClient,
  userId: string,
  tenantId: string,
): Promise<boolean> {
  const role = await tenantRoleOf(client, userId, tenantId);
  return role === "owner" || role === "admin";
}

export async function canUserAccessAgent(
  client: SupabaseClient,
  userId: string,
  tenantId: string,
  agentSlug: string,
  opts?: { read: true },
): Promise<boolean> {
  void agentSlug;
  const role = await tenantRoleOf(client, userId, tenantId);
  if (role === "owner" || role === "admin" || role === "member") return true;
  if (role === "viewer") return opts?.read === true;
  return false;
}

export async function canUserAccessAgentRun(
  client: SupabaseClient,
  userId: string,
  runId: string,
  opts?: { read?: true },
): Promise<boolean> {
  const { data: runRow, error: runErr } = await client
    .from("agent_runs")
    .select("tenant_id")
    .eq("id", runId)
    .maybeSingle<AgentRunMembershipRow>();
  if (runErr || !runRow) return false;
  const role = await tenantRoleOf(client, userId, runRow.tenant_id);
  return role === "owner" || role === "admin" || role === "member" || role === "viewer";
}
