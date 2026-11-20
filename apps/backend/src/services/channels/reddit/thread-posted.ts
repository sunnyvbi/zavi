import type { SupabaseClient } from "@supabase/supabase-js";
import { canonicalRedditUrl } from "./permalink";

export async function markRedditThreadPosted(
  sb: SupabaseClient,
  tenantId: string,
  threadUrl: string,
): Promise<boolean> {
  const url = canonicalRedditUrl(threadUrl);
  if (!url) return false;
  try {
    const { data, error } = await sb
      .from("reddit_threads")
      .update({ draft_state: "posted", draft_updated_at: new Date().toISOString() })
      .eq("tenant_id", tenantId)
      .eq("url", url)
      .select("id");
    if (error) {
      console.error(`[reddit-thread-posted] mark posted failed: ${error.message}`);
      return false;
    }
    return Array.isArray(data) && data.length > 0;
  } catch (e) {
    console.error(`[reddit-thread-posted] mark posted failed: ${(e as Error)?.message ?? e}`);
    return false;
  }
}
