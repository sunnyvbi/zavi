import { assertXWriteAccess } from "@/services/connectors/x-ads/resources";
import { z } from "zod";
import { getXCampaign, xAdsTenantToken, type XCampaignRow } from "@/services/connectors/x-ads/client";
import { xId } from "@/services/connectors/x-ads/schema";
import type { EmitDecisionFn } from "@/services/channels/exec-emit";
import { ExpectedToolError } from "@/services/tools/types";

export const accountIdField = xId.describe("The ad account, from x_ads_list_accounts.");
export const campaignIdField = xId.describe("The campaign, from x_ads_list_campaigns.");
export const rationaleField = z.string().min(1).max(500).describe("Why, citing the numbers you read (spend, clicks, conversions, window).");

export async function liveCampaign(tenantId: string, accountId: string, campaignId: string): Promise<XCampaignRow> {
  const token = await xAdsTenantToken(tenantId);
  await assertXWriteAccess(token, accountId);
  const c = await getXCampaign(token, accountId, campaignId);
  if (!c) throw new ExpectedToolError("x_ads_campaign_not_found", `No campaign ${campaignId} in X Ads account ${accountId}.`);
  return c;
}

export function requireEmit(fn: EmitDecisionFn | undefined): EmitDecisionFn {
  if (typeof fn !== "function") {
    throw new ExpectedToolError("x_ads_propose_unavailable", "This run cannot file an approval card, so nothing was proposed. Ask in a chat or on an X Ads channel run.");
  }
  return fn;
}
