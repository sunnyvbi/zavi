
import { serviceClient } from "@/services/supabase";
import { socialPublishGate } from "@/services/connectors/social-publish-gate";

export const SOCIAL_PUBLISH_PAUSE_KEY = "social_publish_paused";
export const SOCIAL_PUBLISH_FLAG_KEY = SOCIAL_PUBLISH_PAUSE_KEY;

export async function isSocialPublishEnabled(): Promise<boolean> {
  try {
    const sb = serviceClient();
    const { data, error } = await sb
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle();
    if (error) return false;
    const blob = (data?.blob ?? {}) as Record<string, unknown>;
    return blob[SOCIAL_PUBLISH_PAUSE_KEY] !== true;
  } catch {
    return false;
  }
}

export async function socialPublishPausedState(tenantId: string): Promise<boolean | undefined> {
  try {
    const gate = await socialPublishGate(serviceClient(), tenantId);
    if (gate.open) return false;
    return gate.error ? undefined : true;
  } catch {
    return undefined;
  }
}
