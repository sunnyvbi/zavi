import { globalClient } from "@/services/tenant-client";

export const ADS_NO_FRICTION_KEY = "ads_launch_no_friction_enabled";

export function adsNoFrictionFromBlob(blob: unknown): boolean {
  if (!blob || typeof blob !== "object") return false;
  return (blob as Record<string, unknown>)[ADS_NO_FRICTION_KEY] !== false;
}

export async function adsNoFrictionEnabled(): Promise<boolean> {
  try {
    const { data, error } = await globalClient().from("system_config").select("blob").eq("id", 1).maybeSingle();
    return error ? false : adsNoFrictionFromBlob(data?.blob ?? {});
  } catch {
    return false;
  }
}
