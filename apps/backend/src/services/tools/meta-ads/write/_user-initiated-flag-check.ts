
import { serviceClient } from "@/services/supabase";

export async function isUserInitiatedSpendApplyEnabled(): Promise<boolean> {
  try {
    const sb = serviceClient();
    const { data, error } = await sb
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle();
    if (error) return false;
    const blob = (data?.blob ?? {}) as Record<string, unknown>;
    return blob.user_initiated_spend_apply_enabled === true;
  } catch {
    return false;
  }
}
