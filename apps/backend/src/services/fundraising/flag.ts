
import { serviceClient } from "@/services/supabase";

export async function fundraisingPipelineEnabled(
  tenantId: string,
): Promise<boolean> {
  if (!tenantId) return false;
  try {
    const { data, error } = await serviceClient()
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle<{ blob: Record<string, unknown> }>();
    if (error) return false;
    const blob = (data?.blob ?? {}) as Record<string, unknown>;
    if (blob.fundraising_pipeline === true) return true;
    const allowlist = blob.fundraising_pipeline_tenants;
    return Array.isArray(allowlist) && allowlist.includes(tenantId);
  } catch {
    return false;
  }
}
