import { gadsMutateOperations, type GoogleAdGroupLive } from "../_client";
import type { UpdateAdGroupBody } from "./_decision-bodies";
import { shapeUpdateAdGroupOperation } from "./_request-shapers";

export async function googleUpdateAdGroup(
  tenant_id: string,
  live: GoogleAdGroupLive,
  body: UpdateAdGroupBody,
): Promise<{ resource_name: string; updated_fields: string[] }> {
  const op = shapeUpdateAdGroupOperation(body, live.ad_group_resource);
  const results = await gadsMutateOperations(tenant_id, [op]);
  return {
    resource_name: results[0] || live.ad_group_resource,
    updated_fields: "updateMask" in op ? op.updateMask.split(",") : [],
  };
}
