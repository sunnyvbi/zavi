import { globalClient } from "@/services/tenant-client";
import { getBoolSettingStrict } from "@/services/settings";

export const MENTION_ALERT_ROLLOUT_KEY = "mention_alerts_rollout";

async function readRollout(): Promise<unknown> {
  const { data, error } = await globalClient()
    .from("system_config")
    .select("blob")
    .eq("id", 1)
    .maybeSingle<{ blob: Record<string, unknown> }>();
  if (error) return undefined;
  return ((data?.blob ?? {}) as Record<string, unknown>)[MENTION_ALERT_ROLLOUT_KEY];
}

export async function isMentionAlertRolloutPossible(): Promise<boolean> {
  try {
    const raw = await readRollout();
    if (raw === true) return true;
    return typeof raw === "string" && raw.split(",").some((s) => s.trim().length > 0);
  } catch {
    return false;
  }
}

export async function isMentionAlertRolloutEnabled(tenant_id: string): Promise<boolean> {
  try {
    const raw = await readRollout();
    if (raw === true) return true;
    if (typeof raw === "string") {
      return raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .includes(tenant_id);
    }
    return false;
  } catch {
    return false;
  }
}

export async function isMentionAlertOptedIn(tenant_id: string): Promise<boolean> {
  try {
    return await getBoolSettingStrict("mention_alerts_enabled", tenant_id);
  } catch {
    return false;
  }
}
