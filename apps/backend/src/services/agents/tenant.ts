
import { serviceClient } from "@/services/supabase";
import { TenantConfigSchema, type TenantConfig } from "./types";
import { assertValidTenantId } from "@/services/memory/loader";

export class TenantConfigNotFoundError extends Error {
  constructor(tenant_id: string) {
    super(
      `No tenant row found for id ${tenant_id}. ` +
        `Either onboarding hasn't been completed for this user, or the ` +
        `active_tenant_id on profiles is stale.`,
    );
    this.name = "TenantConfigNotFoundError";
  }
}

type CacheEntry = { value: TenantConfig; loadedAtMs: number };

const TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

export function _resetTenantConfigCache(): void {
  cache.clear();
}

export function invalidateTenantConfig(tenant_id: string): void {
  cache.delete(tenant_id);
}

export async function loadTenantConfig(tenant_id: string): Promise<TenantConfig> {
  assertValidTenantId(tenant_id);
  const hit = cache.get(tenant_id);
  if (hit && Date.now() - hit.loadedAtMs < TTL_MS) {
    return hit.value;
  }

  const { data, error } = await serviceClient()
    .from("tenants")
    .select("id, slug, display_name, rar_weekly_threshold, timezone")
    .eq("id", tenant_id)
    .maybeSingle();
  if (error) {
    throw new Error(`tenants read failed for ${tenant_id}: ${error.message}`);
  }
  if (!data) {
    throw new TenantConfigNotFoundError(tenant_id);
  }
  const value = TenantConfigSchema.parse({
    tenant_id: data.id,
    slug: data.slug,
    display_name: data.display_name,
    gmv_thresholds: { RaR_weekly: Number(data.rar_weekly_threshold ?? 3500) },
    channel_ids: {},
    timezone: data.timezone ?? "America/Los_Angeles",
  });

  cache.set(tenant_id, { value, loadedAtMs: Date.now() });
  return value;
}

export function defaultTenantId(): string {
  return "";
}
