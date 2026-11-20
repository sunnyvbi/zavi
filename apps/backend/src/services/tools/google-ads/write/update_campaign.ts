import { gadsMutateOperations, type GoogleCampaignLive } from "../_client";
import type { UpdateCampaignBody } from "./_decision-bodies";
import { shapeUpdateCampaignOperation } from "./_request-shapers";

export async function googleUpdateCampaign(
  tenant_id: string,
  live: GoogleCampaignLive,
  body: UpdateCampaignBody,
): Promise<{ resource_name: string; updated_fields: string[] }> {
  const op = shapeUpdateCampaignOperation(body, live);
  const results = await gadsMutateOperations(tenant_id, [op]);
  return {
    resource_name: results[0] || live.campaign_resource,
    updated_fields: "updateMask" in op ? op.updateMask.split(",") : [],
  };
}
