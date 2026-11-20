
import { serviceClient } from "@/services/supabase";

export async function isCosPrecisionCalibrationEnabled(): Promise<boolean> {
  try {
    const sb = serviceClient();
    const { data, error } = await sb
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle();
    if (error) return false;
    const blob = (data?.blob ?? {}) as Record<string, unknown>;
    return blob.cos_precision_calibration_enabled !== false;
  } catch {
    return false;
  }
}
