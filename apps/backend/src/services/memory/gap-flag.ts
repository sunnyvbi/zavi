
import { getBoolSetting, _resetSettingsCache } from "@/services/settings";

export function _resetGapFlagCache(): void {
  _resetSettingsCache();
}

export async function isGapDistillEnabled(): Promise<boolean> {
  return getBoolSetting("brain_gap_distill");
}
