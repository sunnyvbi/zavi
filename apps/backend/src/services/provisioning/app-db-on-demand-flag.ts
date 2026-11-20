
import type { SupabaseClient } from "@supabase/supabase-js";
import { globalClient } from "@/services/tenant-client";

type Sb = Pick<SupabaseClient, "from">;

export async function isAppDbOnDemandEnabled(sb?: Sb): Promise<boolean> {
  try {
    const client = sb ?? (globalClient() as Sb);
    const { data, error } = await client
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle<{ blob: Record<string, unknown> }>();
    if (error) return false;
    const blob = (data?.blob ?? {}) as Record<string, unknown>;
    return blob.app_db_on_demand !== false;
  } catch {
    return false;
  }
}
