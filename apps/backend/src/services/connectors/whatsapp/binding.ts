
import { asTenantId, tenantClient } from "@/services/tenant-client";

export type EnabledWhatsAppBinding = { tenant_id: string; window_expires_at: string | null };

export async function findEnabledWhatsAppBinding(args: {
  phone_number_id: string;
  wa_id: string;
  tenant_id: string;
}): Promise<EnabledWhatsAppBinding | null> {
  const { data } = await tenantClient(asTenantId(args.tenant_id))
    .from("whatsapp_threads")
    .select("tenant_id, window_expires_at")
    .eq("phone_number_id", args.phone_number_id)
    .eq("wa_id", args.wa_id)
    .eq("status", "enabled")
    .maybeSingle<EnabledWhatsAppBinding>();
  return data ?? null;
}
