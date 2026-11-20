
import { asTenantId, tenantClient } from "@/services/tenant-client";

export async function recordWakeSkip(tenant_id: string, wake_reason: string, why: string): Promise<void> {
  try {
    const { error } = await tenantClient(asTenantId(tenant_id))
      .from("cgo_wake_skips")
      .insert({ tenant_id, wake_reason: wake_reason.slice(0, 60), why: why.slice(0, 120) });
    if (error) console.warn(`[cgo-wake-skips] write failed for ${tenant_id}: ${error.message}`);
  } catch (e) {
    console.warn(`[cgo-wake-skips] write failed for ${tenant_id}: ${(e as Error).message}`);
  }
}
