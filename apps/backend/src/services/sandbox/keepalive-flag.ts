
import { serviceClient } from "@/services/supabase";

type CacheEntry = { at: number; enabled: boolean };
const _cache = new Map<string, CacheEntry>();
const TTL_MS = 60_000;

async function readFromDb(tenant_id: string): Promise<boolean> {
  const { data, error } = await serviceClient()
    .from("tenants")
    .select("sandbox_keepalive_enabled")
    .eq("id", tenant_id)
    .maybeSingle<{ sandbox_keepalive_enabled: boolean | null }>();
  if (error) throw new Error(error.message);
  return data?.sandbox_keepalive_enabled === true;
}

export async function getTenantSandboxKeepalive(
  tenant_id: string,
): Promise<boolean> {
  const now = Date.now();
  const hit = _cache.get(tenant_id);
  if (hit && now - hit.at < TTL_MS) return hit.enabled;

  try {
    const enabled = await readFromDb(tenant_id);
    _cache.set(tenant_id, { at: now, enabled });
    return enabled;
  } catch (e) {
    console.warn(
      `[sandbox-keepalive] flag lookup failed for ${tenant_id}: ${(e as Error).message}; defaulting to OFF (pause as usual)`,
    );
    return false;
  }
}

export function invalidateTenantKeepaliveCache(tenant_id: string): void {
  _cache.delete(tenant_id);
}

export function _invalidateAllKeepaliveCache(): void {
  _cache.clear();
}
