import { createHash } from "node:crypto";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { LINKEDIN_ADS_SLUG } from "./constants";

export async function linkedinCampaignChangeStamp(tenantId: string): Promise<string | null> {
  try {
    const db = tenantClient(asTenantId(tenantId));
    const [lifecycle, operations, cards] = await Promise.all([
      db
        .from("ads_campaign_lifecycle")
        .select("campaign_binding_id, activation_attempted_at, stop_requested_at, stop_confirmed_at")
        .eq("tenant_id", tenantId)
        .order("campaign_binding_id")
        .range(0, 999),
      db.from("ads_campaign_operations").select("updated_at").eq("tenant_id", tenantId).order("updated_at", { ascending: false }).range(0, 0),
      db
        .from("channel_actions")
        .select("executed_at")
        .eq("tenant_id", tenantId)
        .eq("channel_slug", LINKEDIN_ADS_SLUG)
        .order("executed_at", { ascending: false, nullsFirst: false })
        .range(0, 0),
    ]);
    if (lifecycle.error || operations.error || cards.error || !Array.isArray(lifecycle.data) || lifecycle.data.length === 1000) return null;
    return createHash("sha256")
      .update(JSON.stringify([lifecycle.data, operations.data ?? [], cards.data ?? []]))
      .digest("hex")
      .slice(0, 32);
  } catch {
    return null;
  }
}
