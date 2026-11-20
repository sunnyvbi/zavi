
import { getBoolSetting, _resetSettingsCache } from "@/services/settings";

export function _resetLlmEntityExtractFlagCache(_tenant_id?: string): void {
  _resetSettingsCache();
}

export async function isLlmEntityExtractEnabledForTenant(tenant_id: string): Promise<boolean> {
  return getBoolSetting("memory_llm_entity_extract_enabled", tenant_id);
}
