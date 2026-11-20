
import type { SupabaseClient } from "@supabase/supabase-js";
import { switchToTenant } from "@/lib/workspace/tenantSwitch";
import { fetchMyRole, type TenantRole } from "@/lib/members";

export type LandedTenant = {
  tenant_id: string;
  tenant_name: string;
  role: TenantRole;
  switched: boolean;
};

export async function landInInvitedTenant(
  supabase: SupabaseClient,
  userId: string,
  switchTo: (tenantId: string) => Promise<boolean> = switchToTenant,
): Promise<LandedTenant | null> {
  const { data: profile } = await supabase
    .from("profiles")
    .select("active_tenant_id")
    .eq("user_id", userId)
    .maybeSingle();
  const invitedId = (profile?.active_tenant_id as string | null | undefined) ?? null;
  if (!invitedId) return null;

  const switched = await switchTo(invitedId).catch(() => false);

  const { data: tenant } = await supabase
    .from("tenants")
    .select("id, display_name")
    .eq("id", invitedId)
    .maybeSingle();
  const role = (await fetchMyRole(supabase, invitedId)) ?? "member";
  return {
    tenant_id: invitedId,
    tenant_name: (tenant?.display_name as string | null | undefined) ?? "your new team",
    role,
    switched,
  };
}
