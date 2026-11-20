
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveSessionTenantId } from "@/lib/session-tenant-client";

export async function fetchActiveTenant(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ id: string; displayName: string } | null> {
  const activeTenantId = await resolveSessionTenantId(supabase, userId);
  if (!activeTenantId) return null;

  const { data: tenant } = await supabase
    .from("tenants")
    .select("id, display_name")
    .eq("id", activeTenantId)
    .maybeSingle();
  if (!tenant) return null;
  return { id: tenant.id, displayName: tenant.display_name };
}
