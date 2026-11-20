
import { serviceClient } from "@/services/supabase";
import { logEvent } from "@/services/logging/logEvent";

export async function ensureEnrichmentTask(tenantId: string): Promise<string | null> {
  try {
    const { data, error } = await serviceClient().rpc("admin_task_create_once", {
      p_kind: "enrichment",
      p_tenant_id: tenantId,
      p_idempotency_key: `enrichment:${tenantId}`,
      p_priority: 10,
    });
    if (error) {
      console.warn(`[ensureEnrichmentTask] create-once failed for ${tenantId}: ${error.message}`);
      return null;
    }
    const taskId = (data as string | null) ?? null;
    void logEvent({
      level: "info",
      source: "admin-tasks",
      code: "admin_task.created",
      tenant_id: tenantId,
      meta: { kind: "enrichment", reason: "onboarding_complete" },
    }).catch(() => {});
    return taskId;
  } catch (e) {
    console.warn(`[ensureEnrichmentTask] threw for ${tenantId}: ${(e as Error).message}`);
    return null;
  }
}
