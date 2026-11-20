import { gadsMutate } from "../_client";

type Status = "ENABLED" | "PAUSED";

export async function googleSetCampaignStatus(
  tenant_id: string,
  input: { campaign_resource: string; status: Status },
): Promise<{ resource_name: string; status: Status }> {
  const resourceNames = await gadsMutate(tenant_id, "campaigns", [
    {
      updateMask: "status",
      update: {
        resourceName: input.campaign_resource,
        status: input.status,
      },
    },
  ]);
  return {
    resource_name: resourceNames[0] ?? input.campaign_resource,
    status: input.status,
  };
}

export async function googleSetAdGroupStatus(
  tenant_id: string,
  input: { ad_group_resource: string; status: Status },
): Promise<{ resource_name: string; status: Status }> {
  const resourceNames = await gadsMutate(tenant_id, "adGroups", [
    {
      updateMask: "status",
      update: { resourceName: input.ad_group_resource, status: input.status },
    },
  ]);
  return { resource_name: resourceNames[0] ?? input.ad_group_resource, status: input.status };
}

export async function googleSetAdStatus(
  tenant_id: string,
  input: { ad_group_ad_resource: string; status: Status },
): Promise<{ resource_name: string; status: Status }> {
  const resourceNames = await gadsMutate(tenant_id, "adGroupAds", [
    {
      updateMask: "status",
      update: { resourceName: input.ad_group_ad_resource, status: input.status },
    },
  ]);
  return { resource_name: resourceNames[0] ?? input.ad_group_ad_resource, status: input.status };
}
