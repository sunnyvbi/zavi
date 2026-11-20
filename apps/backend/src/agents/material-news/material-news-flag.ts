
import { tenantClient, globalClient, asTenantId } from "@/services/tenant-client";

export async function isMaterialNewsRolloutEnabled(tenant_id: string): Promise<boolean> {
  try {
    const { data, error } = await globalClient()
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle<{ blob: Record<string, unknown> }>();
    if (error) return false;
    const blob = (data?.blob ?? {}) as Record<string, unknown>;
    const raw = blob.material_news_rollout;

    if (raw === true) return true;

    if (typeof raw === "string") {
      const allowed = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      return allowed.includes(tenant_id);
    }

    return false;
  } catch {
    return false;
  }
}

export async function isMaterialNewsOptedIn(tenant_id: string): Promise<boolean> {
  try {
    const { data: tRow, error: tErr } = await tenantClient(asTenantId(tenant_id))
      .from("tenant_app_setting")
      .select("value")
      .eq("key", "material_news_enabled")
      .maybeSingle<{ value: unknown }>();
    if (tErr) return false;
    if (tRow && tRow.value === false) return false;
    if (tRow && tRow.value === true) return true;
    const { data: gRow, error: gErr } = await globalClient()
      .from("app_setting")
      .select("value")
      .eq("key", "material_news_enabled")
      .maybeSingle<{ value: unknown }>();
    if (gErr) return false;
    if (gRow && gRow.value === true) return true;
    return false;
  } catch {
    return false;
  }
}
