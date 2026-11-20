"use client";

import { CampaignThumbnail } from "./CampaignThumbnail";

export function MetaCampaignThumbnail({ campaignId, campaignIds, name }: { campaignId: string; campaignIds?: string; name: string }) {
  return <CampaignThumbnail channel="meta_ads" campaignId={campaignId} campaignIds={campaignIds} name={name} />;
}
