
import { serviceClient } from "@/services/supabase";

export async function isAdvisorCriticXfamilyEnabled(
  tenantId: string,
): Promise<boolean> {
  try {
    const sb = serviceClient();
    const { data, error } = await sb
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle();
    if (error) return false;
    const blob = (data?.blob ?? {}) as Record<string, unknown>;
    const cfg = (blob.advisor_critic_xfamily ?? {}) as Record<string, unknown>;
    if (cfg.enabled !== true) return false;
    const allowlist = Array.isArray(cfg.tenant_allowlist)
      ? (cfg.tenant_allowlist as unknown[]).filter(
          (t): t is string => typeof t === "string",
        )
      : [];
    if (allowlist.length === 0) return true;
    return allowlist.includes(tenantId);
  } catch {
    return false;
  }
}
