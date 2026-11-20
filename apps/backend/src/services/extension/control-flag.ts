
import { globalClient } from "@/services/tenant-client";

export const EXTENSION_BROWSER_CONTROL_FLAG_KEY = "extension_browser_control_enabled";

export async function isExtensionBrowserControlEnabled(): Promise<boolean> {
  try {
    const { data, error } = await globalClient()
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle();
    if (error || !data) return false;
    const blob = (data.blob ?? {}) as Record<string, unknown>;
    return blob[EXTENSION_BROWSER_CONTROL_FLAG_KEY] !== false;
  } catch {
    return false;
  }
}
