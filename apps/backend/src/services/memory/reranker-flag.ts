
import { getBoolSetting, _resetSettingsCache } from "@/services/settings";

export function _resetRerankerFlagCache(_tenant_id?: string): void {
  _resetSettingsCache();
}

export async function isRerankerEnabledForTenant(tenant_id: string): Promise<boolean> {
  return getBoolSetting("memory_reranker_enabled", tenant_id);
}
