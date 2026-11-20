import {
  gadsGetAd,
  gadsGetAdGroup,
  gadsGetCampaign,
  gadsGetKeyword,
  gadsMutateOperations,
  type GadsMutateService,
} from "../_client";
import type { RemoveResourceBody } from "./_decision-bodies";

export async function googleRemoveResource(
  tenant_id: string,
  body: RemoveResourceBody,
): Promise<{ removed_resource: string; label: string }> {
  let service: GadsMutateService;
  let resource: string;
  let label: string;
  switch (body.level) {
    case "campaign": {
      const live = await gadsGetCampaign(tenant_id, body.campaign_id);
      service = "campaigns";
      resource = live.campaign_resource;
      label = `campaign "${live.name}"`;
      break;
    }
    case "ad_group": {
      const live = await gadsGetAdGroup(tenant_id, body.ad_group_id);
      service = "adGroups";
      resource = live.ad_group_resource;
      label = `ad group "${live.name}"`;
      break;
    }
    case "ad": {
      const live = await gadsGetAd(tenant_id, body.ad_group_id, body.ad_id);
      service = "adGroupAds";
      resource = live.ad_group_ad_resource;
      label = `ad ${live.ad_id}`;
      break;
    }
    case "keyword": {
      const scope =
        body.scope === "ad_group"
          ? ({ level: "ad_group", ad_group_id: body.parent_id } as const)
          : ({ level: "campaign", campaign_id: body.parent_id } as const);
      const live = await gadsGetKeyword(tenant_id, scope, body.criterion_id);
      service = body.scope === "ad_group" ? "adGroupCriteria" : "campaignCriteria";
      resource = live.criterion_resource;
      label = `${live.negative ? "negative " : ""}keyword "${live.text}" (${live.match_type})`;
      break;
    }
  }
  const results = await gadsMutateOperations(tenant_id, [{ service, remove: resource }]);
  return { removed_resource: results[0] || resource, label };
}
