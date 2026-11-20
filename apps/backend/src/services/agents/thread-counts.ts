
import type { SupabaseClient } from "@supabase/supabase-js";

const THREAD_DISPLAY_CAP = 12;

export async function countThreadsBySlug(
  supabase: SupabaseClient,
  tenantId: string,
  userId: string,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const { data, error } = await supabase
    .from("agent_threads")
    .select("agent_slug")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .is("deleted_at", null);
  if (error || !data) return counts;
  for (const r of data as Array<{ agent_slug: string | null }>) {
    if (!r.agent_slug) continue;
    counts.set(r.agent_slug, (counts.get(r.agent_slug) ?? 0) + 1);
  }
  for (const [slug, n] of counts) {
    if (n > THREAD_DISPLAY_CAP) counts.set(slug, THREAD_DISPLAY_CAP);
  }
  return counts;
}
