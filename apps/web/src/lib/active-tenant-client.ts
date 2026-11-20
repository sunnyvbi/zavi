
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveSessionTenantId } from "@/lib/session-tenant-client";
import { getVerifiedUser } from "@/lib/verifiedUser";

let cached: string | null | undefined;
let inflight: Promise<string | null> | null = null;

export async function getActiveTenantId(
  sb: SupabaseClient,
): Promise<string | null> {
  if (cached !== undefined) return cached;
  if (inflight) return inflight;
  const request = resolveActiveTenantId(sb).finally(() => {
    if (inflight === request) inflight = null;
  });
  inflight = request;
  return request;
}

async function resolveActiveTenantId(
  sb: SupabaseClient,
): Promise<string | null> {
  const user = await getVerifiedUser(sb);
  if (!user) {
    return null;
  }

  const resolved = await resolveSessionTenantId(sb, user.id);
  if (resolved === null) {
    return null;
  }
  cached = resolved;
  return cached;
}

export function clearActiveTenantCache(): void {
  cached = undefined;
  inflight = null;
}
