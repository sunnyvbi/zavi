
import { serviceClient } from "@/services/supabase";
import { invalidateCachedTenant } from "@/services/auth/tenant-cache";

export async function syncActiveTenant(
  user_id: string,
  tenant_id: string,
): Promise<void> {
  const { error } = await serviceClient()
    .from("profiles")
    .update({ active_tenant_id: tenant_id })
    .eq("user_id", user_id);
  if (error) {
    console.warn(
      `[active-tenant] sync failed for ${user_id} → ${tenant_id}: ${error.message}`,
    );
    return;
  }
  invalidateCachedTenant(user_id);
}

export async function syncActiveTenantStrict(
  user_id: string,
  tenant_id: string,
): Promise<void> {
  const { data, error } = await serviceClient()
    .from("profiles")
    .update({ active_tenant_id: tenant_id })
    .eq("user_id", user_id)
    .select("user_id")
    .maybeSingle();
  if (error) {
    throw new Error(`active-tenant sync failed: ${error.message}`);
  }
  if (!data) {
    throw new Error("active-tenant sync failed: no profile row updated");
  }
  invalidateCachedTenant(user_id);
}

export async function getSessionTenant(
  session_id: string,
): Promise<string | null> {
  const { data, error } = await serviceClient()
    .from("session_tenants")
    .select("tenant_id")
    .eq("session_id", session_id)
    .maybeSingle();
  if (error) {
    console.warn(
      `[session-tenant] read failed for session ${session_id}: ${error.message}`,
    );
    return null;
  }
  return (data?.tenant_id as string | undefined) ?? null;
}

export async function setSessionTenant(
  session_id: string,
  user_id: string,
  tenant_id: string,
): Promise<void> {
  const { error } = await serviceClient()
    .from("session_tenants")
    .upsert(
      { session_id, user_id, tenant_id, updated_at: new Date().toISOString() },
      { onConflict: "session_id" },
    );
  if (error) {
    throw new Error(`session-tenant pin failed: ${error.message}`);
  }
  invalidateCachedTenant(user_id);
}

export async function clearSessionTenantsForMembership(
  user_id: string,
  tenant_id: string,
): Promise<void> {
  const { error } = await serviceClient()
    .from("session_tenants")
    .delete()
    .eq("user_id", user_id)
    .eq("tenant_id", tenant_id);
  if (error) {
    console.warn(
      `[session-tenant] clear failed for ${user_id} @ ${tenant_id}: ${error.message}`,
    );
    return;
  }
  invalidateCachedTenant(user_id);
}
