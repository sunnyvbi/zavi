import { campaignFetch, requestKey } from "../managed-campaigns/api";
import { TIKTOK_CAMPAIGN_API as base, type TiktokCampaignDetail, type TiktokCampaignTarget } from "./types";

export async function requestTiktokCampaignStatus(target: TiktokCampaignTarget, on: boolean): Promise<void> {
  const detail = await campaignFetch<TiktokCampaignDetail>(`${base}/campaigns/${encodeURIComponent(target.campaign_id)}?advertiser_id=${encodeURIComponent(target.advertiser_id)}`);
  const path = `${base}/campaign-edits`;
  const body = { ...target, level: "campaign", object_id: detail.campaign.id, revision: detail.campaign.revision, changes: { status: on ? "ACTIVE" : "PAUSED" } };
  const { id } = requestKey(null, path, body);
  await campaignFetch<{ action_id: string }>(path, { method: "POST", body: JSON.stringify({ ...body, request_id: id }), headers: { "Idempotency-Key": id } });
}
