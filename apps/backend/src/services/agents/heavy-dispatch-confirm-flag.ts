
import type { SupabaseClient } from "@supabase/supabase-js";
import { globalClient } from "@/services/tenant-client";

type Sb = Pick<SupabaseClient, "from">;

export async function isHeavyDispatchConfirmEnabled(sb?: Sb): Promise<boolean> {
  try {
    const client = sb ?? (globalClient() as Sb);
    const { data, error } = await client
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle<{ blob: Record<string, unknown> }>();
    if (error) return true;
    const blob = (data?.blob ?? {}) as Record<string, unknown>;
    return blob.heavy_dispatch_confirm !== false;
  } catch {
    return true;
  }
}
