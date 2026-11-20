import { z } from "zod";

export const campaignMediaChannels = ["meta_ads", "google_ads", "youtube_ads", "tiktok_ads", "linkedin_ads", "reddit_ads", "x_ads", "chatgpt_ads"] as const;
export const campaignMediaChannelSchema = z.enum(campaignMediaChannels);
export type CampaignMediaChannel = z.infer<typeof campaignMediaChannelSchema>;
export function isCampaignMediaChannel(value: string): value is CampaignMediaChannel {
  return campaignMediaChannelSchema.safeParse(value).success;
}
