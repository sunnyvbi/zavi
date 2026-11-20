
import { serviceClient } from "@/services/supabase";
import { getAppSetting } from "@/services/settings";

export async function isPmRoadmapEnabled(): Promise<boolean> {
  try {
    const settingOverride = await getAppSetting("pm_roadmap_enabled");
    if (settingOverride !== undefined) return settingOverride === true;
    const sb = serviceClient();
    const { data, error } = await sb
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle();
    if (error) return false;
    const blob = (data?.blob ?? {}) as Record<string, unknown>;
    return blob.pm_roadmap_enabled !== false;
  } catch {
    return false;
  }
}
