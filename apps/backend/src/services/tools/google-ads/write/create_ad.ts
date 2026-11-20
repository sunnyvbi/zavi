import { gadsMutateOperations, type GoogleAdGroupLive } from "../_client";
import { ExpectedToolError } from "@/services/tools/types";
import { checkAdKindForAdGroupType, type CreateAdBody } from "./_decision-bodies";
import { resourceId } from "./_helpers";
import { shapeAdOperations } from "./_request-shapers";

export async function googleCreateAd(
  tenant_id: string,
  adGroup: GoogleAdGroupLive,
  body: CreateAdBody,
): Promise<{ ad_id: string; ad_group_ad_resource: string; created_resources: number }> {
  const kindErr = checkAdKindForAdGroupType(body.ad.kind, adGroup.type);
  if (kindErr) throw new ExpectedToolError("google_ads_ad_kind_mismatch", kindErr);
  const ops = shapeAdOperations([body.ad], adGroup.ad_group_resource);
  const results = await gadsMutateOperations(tenant_id, ops);
  const ad_group_ad_resource = results[results.length - 1] || "";
  if (!ad_group_ad_resource) {
    throw new ExpectedToolError(
      "google_ads_create_ad_no_resource",
      "Google Ads returned no resource name for the created ad.",
    );
  }
  return {
    ad_id: resourceId(ad_group_ad_resource),
    ad_group_ad_resource,
    created_resources: results.length,
  };
}
