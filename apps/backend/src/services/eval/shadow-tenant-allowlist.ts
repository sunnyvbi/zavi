
import { serviceClient } from "@/services/supabase";

export const SHADOW_DOGFOOD_TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";

export async function isShadowTenantAllowed(tenantId: string): Promise<boolean> {
  if (!tenantId) return false;
  if (tenantId === SHADOW_DOGFOOD_TENANT) return true;

  try {
    const sb = serviceClient();
    const { data, error } = await sb
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle();
    if (error) return false;
    const blob = (data?.blob ?? {}) as Record<string, unknown>;
    const list = blob.shadow_customer_tenant_ids;
    if (!Array.isArray(list)) return false;
    return list.includes(tenantId);
  } catch {
    return false;
  }
}

export async function assertShadowTenantAllowed(tenantId: string): Promise<void> {
  if (!(await isShadowTenantAllowed(tenantId))) {
    throw new Error(
      `tenant ${tenantId} is not on the shadow allowlist ` +
        `(system_config.blob.shadow_customer_tenant_ids). ` +
        `Shadow replay/grade is refused fail-closed.`,
    );
  }
}
