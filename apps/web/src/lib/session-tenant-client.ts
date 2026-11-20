
import type { SupabaseClient } from "@supabase/supabase-js";
import { decodeActiveTenantClaim, decodeSessionId } from "@/lib/tenant-claim";

export async function resolveSessionTenantId(
  sb: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const {
    data: { session },
  } = await sb.auth.getSession();
  const token = session?.access_token;
  if (!token) return null;

  const sessionId = decodeSessionId(token);
  if (sessionId) {
    const { data } = await sb
      .from("session_tenants")
      .select("tenant_id")
      .eq("session_id", sessionId)
      .maybeSingle();
    const pinned = data?.tenant_id as string | undefined;
    if (pinned) return pinned;
  }

  const claim = decodeActiveTenantClaim(token);
  if (claim) return claim;

  const { data: profile } = await sb
    .from("profiles")
    .select("active_tenant_id")
    .eq("user_id", userId)
    .maybeSingle();
  return (profile?.active_tenant_id as string | undefined) ?? null;
}
