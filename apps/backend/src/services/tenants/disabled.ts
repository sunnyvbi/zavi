
import { asTenantId, tenantClient } from "@/services/tenant-client";

export const TENANT_DISABLED_CODE = "tenant_disabled";
export const TENANT_DISABLED_MESSAGE =
  "This workspace is disabled. Contact support@zaviagent.com.";

const TTL_MS = 15_000;
const cache = new Map<string, { disabled: boolean; at: number }>();

export async function readTenantDisabled(tenantId: string): Promise<boolean | null> {
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.disabled;
  try {
    const { data, error } = await tenantClient(asTenantId(tenantId))
      .from("tenants")
      .select("disabled_at")
      .maybeSingle();
    if (error) {
      console.warn(`[tenant-disabled] read failed for ${tenantId}: ${error.message}`);
      return null;
    }
    const disabled = !!(data as { disabled_at?: string | null } | null)?.disabled_at;
    cache.set(tenantId, { disabled, at: Date.now() });
    return disabled;
  } catch (e) {
    console.warn(`[tenant-disabled] read threw for ${tenantId}: ${(e as Error).message}`);
    return null;
  }
}

export async function isTenantDisabled(
  tenantId: string,
  onError: "open" | "closed" = "closed",
): Promise<boolean> {
  const v = await readTenantDisabled(tenantId);
  return v === null ? onError === "closed" : v;
}

export function invalidateTenantDisabledCache(tenantId?: string): void {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
}

export class TenantDisabledError extends Error {
  readonly code = TENANT_DISABLED_CODE;
  constructor() {
    super(TENANT_DISABLED_MESSAGE);
    this.name = "TenantDisabledError";
  }
}
