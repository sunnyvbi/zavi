import { asTenantId, tenantClient } from "@/services/tenant-client";

export async function storedComposioAccount(tenant_id: string, toolkit: string): Promise<string | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("connector_metadata")
    .select("team_id")
    .eq("slug", `composio.${toolkit}`)
    .maybeSingle();
  if (error) return null;
  return ((data as { team_id?: string | null } | null)?.team_id ?? "").trim();
}

export async function deleteComposioRow(tenant_id: string, slug: string, onlyAccountId?: string): Promise<{ message: string } | null> {
  const db = tenantClient(asTenantId(tenant_id));
  let del = db
    .from("connector_metadata")
    .delete()
    .eq("slug", slug);
  if (onlyAccountId) del = del.eq("team_id", onlyAccountId);
  const { error } = await del;
  if (error) return error;
  const { data: remaining } = await db
    .from("connector_metadata")
    .select("slug")
    .like("slug", "composio.%")
    .limit(1);
  if (!remaining || (remaining as unknown[]).length === 0) {
    await db
      .from("tenant_mcp_servers")
      .update({ enabled: false })
      .eq("server_id", "composio");
  }
  return null;
}
