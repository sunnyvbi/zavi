
import { serviceClient } from "@/services/supabase";

export async function isGoogleAdsWriteEnabled(): Promise<boolean> {
  try {
    const sb = serviceClient();
    const { data, error } = await sb
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle();
    if (error) return false;
    const blob = (data?.blob ?? {}) as Record<string, unknown>;
    return blob.google_ads_write_enabled !== false;
  } catch {
    return false;
  }
}
