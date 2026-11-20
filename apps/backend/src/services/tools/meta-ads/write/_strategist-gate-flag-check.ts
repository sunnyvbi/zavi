
import { getBoolSetting } from "@/services/settings";

export async function isStrategistGateEnabled(tenant_id: string): Promise<boolean> {
  return getBoolSetting("strategist_gate_enabled", tenant_id);
}
