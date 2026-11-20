
import { serviceClient } from "@/services/supabase";
import { isFeatureEnabled } from "@/services/gatekeeper";
import { MULTI_WORKSPACE_FLAG } from "@/services/gatekeeper/known-flags";

export const MAX_SELF_SERVE_TENANTS = 5;

export async function countOwnedTenants(user_id: string): Promise<number> {
  const { count, error } = await serviceClient()
    .from("tenant_users")
    .select("tenant_id", { count: "exact", head: true })
    .eq("user_id", user_id)
    .eq("role", "owner");
  if (error) {
    // eslint-disable-next-line no-console
    console.warn(`[tenant-create-guard] owned-count failed for ${user_id}: ${error.message}`);
    return 0;
  }
  return count ?? 0;
}

export type TenantCreateRejection = {
  code: "tenant_limit" | "multi_workspace_not_enabled";
  message: string;
};

export async function checkSelfServeTenantCap(
  user_id: string,
): Promise<TenantCreateRejection | null> {
  const owned = await countOwnedTenants(user_id);
  if (owned >= 1 && !(await isFeatureEnabled(MULTI_WORKSPACE_FLAG, user_id))) {
    return {
      code: "multi_workspace_not_enabled",
      message: "Adding another company isn't available on your account yet. Contact support if you need it.",
    };
  }
  if (owned >= MAX_SELF_SERVE_TENANTS) {
    return {
      code: "tenant_limit",
      message: `You've reached the limit of ${MAX_SELF_SERVE_TENANTS} companies. Contact support to add more.`,
    };
  }
  return null;
}
