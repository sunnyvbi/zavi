
import { serviceClient } from "@/services/supabase";

export async function isBatchFanoutAllowlisted(tenantId: string): Promise<boolean> {
  try {
    const sb = serviceClient();
    const { data, error } = await sb
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle();
    if (error) return false;
    const blob = (data?.blob ?? {}) as Record<string, unknown>;
    const list = blob.batch_fanout_tenant_allowlist;
    if (!Array.isArray(list)) return false;
    return list.some((entry) => typeof entry === "string" && entry === tenantId);
  } catch {
    return false;
  }
}
