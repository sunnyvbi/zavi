import {
  gadsCustomerId,
  gadsListAdGroupNames,
  gadsMutateOperations,
  type GoogleCampaignLive,
} from "../_client";
import { ExpectedToolError } from "@/services/tools/types";
import { checkAdGroupTypeForChannel, type CreateAdGroupBody } from "./_decision-bodies";
import { assertNoGoogleNameCollision, resourceId } from "./_helpers";
import { newTempIds, shapeAdGroupOperations } from "./_request-shapers";

export async function googleCreateAdGroup(
  tenant_id: string,
  campaign: GoogleCampaignLive,
  body: CreateAdGroupBody,
): Promise<{ ad_group_id: string; ad_group_resource: string; created_resources: number }> {
  const typeErr = checkAdGroupTypeForChannel(body.type, campaign.channel_type);
  if (typeErr) throw new ExpectedToolError("google_ads_ad_group_type_mismatch", typeErr);
  const existing = await gadsListAdGroupNames(tenant_id, campaign.campaign_id);
  assertNoGoogleNameCollision(existing, body.name, "ad group");
  const customer_id = await gadsCustomerId(tenant_id);
  const shaped = shapeAdGroupOperations(body, campaign.campaign_resource, newTempIds(customer_id));
  const results = await gadsMutateOperations(tenant_id, shaped.ops);
  const ad_group_resource = results[0] || shaped.ad_group_resource;
  return {
    ad_group_id: resourceId(ad_group_resource),
    ad_group_resource,
    created_resources: results.length,
  };
}
