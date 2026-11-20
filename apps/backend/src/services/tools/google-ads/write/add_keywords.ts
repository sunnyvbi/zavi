import {
  gadsGetAdGroup,
  gadsGetCampaign,
  gadsMutateOperations,
} from "../_client";
import { ExpectedToolError } from "@/services/tools/types";
import type { AddKeywordsBody } from "./_decision-bodies";
import { shapeKeywordOperations } from "./_request-shapers";

export async function googleAddKeywords(
  tenant_id: string,
  body: AddKeywordsBody,
): Promise<{ created: number; parent_resource: string }> {
  if (body.level === "ad_group") {
    if (!body.ad_group_id) {
      throw new ExpectedToolError("google_ads_invalid_ad_group_id", "ad_group_id is required");
    }
    const adGroup = await gadsGetAdGroup(tenant_id, body.ad_group_id);
    if (adGroup.type !== "SEARCH_STANDARD") {
      throw new ExpectedToolError(
        "google_ads_keywords_need_search_ad_group",
        `Keywords attach to SEARCH_STANDARD ad groups only; ad group ${body.ad_group_id} is ${adGroup.type || "unknown"}.`,
      );
    }
    const ops = shapeKeywordOperations(body.keywords, {
      ad_group_resource: adGroup.ad_group_resource,
      negative: body.negative,
    });
    const results = await gadsMutateOperations(tenant_id, ops);
    return { created: results.length, parent_resource: adGroup.ad_group_resource };
  }
  if (!body.campaign_id) {
    throw new ExpectedToolError("google_ads_invalid_campaign_id", "campaign_id is required");
  }
  const campaign = await gadsGetCampaign(tenant_id, body.campaign_id);
  const ops = shapeKeywordOperations(body.keywords, {
    campaign_resource: campaign.campaign_resource,
  });
  const results = await gadsMutateOperations(tenant_id, ops);
  return { created: results.length, parent_resource: campaign.campaign_resource };
}
