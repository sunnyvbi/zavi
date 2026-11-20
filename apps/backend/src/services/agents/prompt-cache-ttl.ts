
import { buildConductorRunIdOf } from "@/services/billing/tiers";
import { getBoolSetting } from "@/services/settings";
import type { PromptCacheTtl } from "./agent-auth";

export const BUILD_PROMPT_CACHE_SETTING = "build_prompt_cache_5m";

export function isBuildOrEditRunPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  return buildConductorRunIdOf(payload) !== null || (payload as Record<string, unknown>).refine_mode === true;
}

export async function promptCacheTtlForRun(
  tenant_id: string,
  payload: unknown,
  read: (key: typeof BUILD_PROMPT_CACHE_SETTING, tenant_id: string) => Promise<boolean> = getBoolSetting,
): Promise<PromptCacheTtl> {
  if (!isBuildOrEditRunPayload(payload)) return "1h";
  try {
    return (await read(BUILD_PROMPT_CACHE_SETTING, tenant_id)) ? "5m" : "1h";
  } catch {
    return "5m";
  }
}
