
import type { SupabaseClient } from "@supabase/supabase-js";
import { decodeActiveTenantClaim } from "@/lib/tenant-claim";

export { decodeActiveTenantClaim };

export async function refreshSessionUntilClaim(
  sb: SupabaseClient,
  targetTenantId: string,
): Promise<boolean> {
  try {
    const { data, error } = await sb.auth.refreshSession();
    if (error) return false;
    const fresh = data?.session?.access_token
      ? decodeActiveTenantClaim(data.session.access_token)
      : null;
    return fresh === targetTenantId;
  } catch {
    return false;
  }
}

let attempted = false;

export async function ensureTenantClaim(sb: SupabaseClient): Promise<void> {
  if (attempted) return;
  attempted = true;
  try {
    const {
      data: { session },
    } = await sb.auth.getSession();
    if (!session?.access_token) return;
    if (decodeActiveTenantClaim(session.access_token)) return;

    const { data, error } = await sb.auth.refreshSession();
    if (error) return;
    const fresh = data?.session?.access_token
      ? decodeActiveTenantClaim(data.session.access_token)
      : null;
    if (fresh) window.location.reload();
  } catch {
  }
}
