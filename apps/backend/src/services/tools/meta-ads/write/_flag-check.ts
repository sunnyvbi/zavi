
import { serviceClient } from "@/services/supabase";

export async function isMetaAdsWriteEnabled(): Promise<boolean> {
  try {
    const sb = serviceClient();
    const { data, error } = await sb
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle();
    if (error) return false;
    const blob = (data?.blob ?? {}) as Record<string, unknown>;
    return blob.meta_ads_write_enabled === true;
  } catch {
    return false;
  }
}
