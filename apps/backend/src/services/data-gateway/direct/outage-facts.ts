import { asTenantId, tenantClient, globalClient } from "@/services/tenant-client";

export async function lastSuccessfulReadAt(tenant_id: string): Promise<string | null> {
  try {
    const { data } = await tenantClient(asTenantId(tenant_id))
      .from("data_access_log")
      .select("created_at")
      .eq("result", "allowed")
      .eq("mode", "direct")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return (data as { created_at?: string } | null)?.created_at ?? null;
  } catch {
    return null;
  }
}

export function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms).unref?.())]);
}

export async function egressIps(): Promise<string[]> {
  try {
    const { data } = await globalClient().from("system_config").select("blob").eq("id", 1).maybeSingle();
    const v = (((data as { blob?: unknown } | null)?.blob ?? {}) as Record<string, unknown>).egress_ips;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, 10) : [];
  } catch {
    return [];
  }
}
