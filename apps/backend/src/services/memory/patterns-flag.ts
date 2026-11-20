
import { getBoolSetting, _resetSettingsCache } from "@/services/settings";
import { serviceClient } from "@/services/supabase";

export function _resetPatternsFlagCache(_tenant_id?: string): void {
  _resetSettingsCache();
}

export async function isPatternsEnabledForTenant(tenant_id: string): Promise<boolean> {
  return getBoolSetting("brain_eval_patterns", tenant_id);
}

export async function assertTenantOptedIn(tenant_id: string): Promise<boolean> {
  if (!tenant_id || typeof tenant_id !== "string") return false;
  try {
    const { data } = await serviceClient()
      .from("tenants")
      .select("id")
      .eq("id", tenant_id)
      .maybeSingle();
    if (!data) return false;
  } catch {
    return false;
  }
  return isPatternsEnabledForTenant(tenant_id);
}

export async function listPatternsEnabledTenantIds(): Promise<string[]> {
  const sb = serviceClient();
  const globalDefault = await getBoolSetting("brain_eval_patterns");

  const { data: overrides, error: ovErr } = await sb
    .from("tenant_app_setting")
    .select("tenant_id, value")
    .eq("key", "brain_eval_patterns");
  if (ovErr) return [];
  const explicitTrue = new Set<string>();
  const explicitFalse = new Set<string>();
  for (const r of (overrides ?? []) as Array<{ tenant_id: string; value: unknown }>) {
    const v = r.value;
    const isTrue = v === true || v === "true";
    const isFalse = v === false || v === "false";
    if (isTrue) explicitTrue.add(r.tenant_id);
    else if (isFalse) explicitFalse.add(r.tenant_id);
  }

  if (!globalDefault) {
    return Array.from(explicitTrue);
  }

  const { data: allT, error } = await sb.from("tenants").select("id").limit(5000);
  if (error) return Array.from(explicitTrue);
  return ((allT ?? []) as Array<{ id: string }>).map((r) => r.id).filter((id) => !explicitFalse.has(id));
}
