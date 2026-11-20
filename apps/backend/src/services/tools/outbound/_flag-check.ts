
import { serviceClient } from "@/services/supabase";

export async function isOutboundEmailProducerEnabled(
  tenantId: string,
): Promise<boolean> {
  try {
    if (!tenantId) return false;
    const sb = serviceClient();
    const { data, error } = await sb
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle<{ blob: Record<string, unknown> }>();
    if (error) return false;
    const blob = (data?.blob ?? {}) as Record<string, unknown>;
    if (blob.outbound_email_producer_enabled === false) return false;
    const allow = blob.outbound_email_producer_tenants;
    if (Array.isArray(allow) && allow.length > 0) return allow.includes(tenantId);
    return true;
  } catch {
    return false;
  }
}
