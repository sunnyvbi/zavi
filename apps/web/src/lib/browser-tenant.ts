
import type { SupabaseClient } from "@supabase/supabase-js";
import { ensureTenantClaim } from "@/lib/ensure-tenant-claim";

const STORAGE_KEY = "zavi_active_tenant";

function dropLegacyKey(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
  }
}

export async function writeStoredTenant(
  _sb: SupabaseClient,
  _tenantId: string,
): Promise<void> {
  dropLegacyKey();
}

export async function reconcileBrowserTenant(sb: SupabaseClient): Promise<void> {
  dropLegacyKey();
  await ensureTenantClaim(sb);
}
