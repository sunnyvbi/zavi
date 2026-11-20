
import { asTenantId, tenantClient } from "@/services/tenant-client";

export async function readChannelStopped(tenantId: string, channelSlug: string): Promise<boolean | null> {
  try {
    const { data, error } = await tenantClient(asTenantId(tenantId))
      .from("tenant_channels")
      .select("plan_selected_set_by")
      .eq("tenant_id", tenantId)
      .eq("channel_slug", channelSlug)
      .maybeSingle<{ plan_selected_set_by: string | null }>();
    if (error) return null;
    return data?.plan_selected_set_by === "founder_stopped";
  } catch {
    return null;
  }
}
