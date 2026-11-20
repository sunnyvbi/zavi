import type { TiktokCampaignTarget } from "./types";
export const TIKTOK_CAMPAIGN_OPEN = "zavi:tiktok-campaign-open";
export const TIKTOK_CAMPAIGN_NEW = "zavi:tiktok-campaign-new";
export function openNewTiktokCampaign(): void {
  window.dispatchEvent(new Event(TIKTOK_CAMPAIGN_NEW));
}
export function openTiktokCampaign(target: TiktokCampaignTarget): void {
  window.dispatchEvent(new CustomEvent(TIKTOK_CAMPAIGN_OPEN, { detail: target }));
}
