import { z } from "zod";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { getCampaignBinding } from "./bindings";
import { withBoundCampaign } from "./campaign-context";

export async function withChatgptBudgetCampaign<T>(
  tenantId: string,
  objectId: string,
  work: (providerId: string) => Promise<T>,
): Promise<T> {
  if (z.string().uuid().safeParse(objectId).success) {
    const result = await tenantClient(asTenantId(tenantId))
      .from("ads_campaign_binding_details")
      .select("id")
      .eq("id", objectId)
      .eq("platform", "chatgpt")
      .maybeSingle();
    if (result.error)
      throw new Error("Campaign budget identity is unavailable");
    if (result.data) {
      const binding = await getCampaignBinding(tenantId, objectId);
      return withBoundCampaign(binding, () =>
        work(binding.provider_campaign_id),
      );
    }
    throw new Error("Campaign budget identity does not belong to this tenant");
  }
  return work(objectId);
}
