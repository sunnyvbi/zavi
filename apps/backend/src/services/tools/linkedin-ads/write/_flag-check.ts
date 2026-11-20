import { envFlagOn } from "@/services/config/env-flag";

export const LINKEDIN_ADS_WRITES_OFF_MESSAGE = "LinkedIn Ads changes are switched off on this server";

export async function isLinkedInAdsWriteEnabled(): Promise<boolean> {
  return envFlagOn(process.env.LINKEDIN_ADS_WRITE_ENABLED);
}
