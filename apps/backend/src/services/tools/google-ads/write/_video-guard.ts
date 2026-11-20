import { ExpectedToolError } from "@/services/tools/types";
import { gadsGetAdGroup, gadsGetCampaignBudget } from "@/services/tools/google-ads/_client";
import { logEvent } from "@/services/logging/logEvent";

export const VIDEO_MUTATE_UNSUPPORTED =
  "Google's Ads API cannot change VIDEO campaigns, so Zavi did not apply this. Nothing in the account changed.";
const PROPOSE_REFUSAL = "Google's Ads API cannot change VIDEO campaigns. Make a manual card for the founder instead.";

const MEANINGFUL_READ_CODES = new Set(["google_ads_campaign_not_found", "google_ads_invalid_campaign_id", "google_ads_ad_group_not_found", "google_ads_invalid_ad_group_id"]);

async function checked<T>(tenant_id: string, what: string, read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (e) {
    if (e instanceof ExpectedToolError && MEANINGFUL_READ_CODES.has(e.code)) throw e;
    void logEvent({
      level: "warn",
      source: "google_ads.video_guard",
      code: "video_guard_read_failed",
      message: `${what}: ${(e as Error).message}`.slice(0, 300),
      tenant_id,
    });
    return null;
  }
}

export async function assertNotVideoCampaign(tenant_id: string, campaign_id: string): Promise<void> {
  const live = await checked(tenant_id, `campaign ${campaign_id}`, () => gadsGetCampaignBudget(tenant_id, campaign_id));
  if (live?.channel_type === "VIDEO") throw new ExpectedToolError("google_ads_video_mutate_unsupported", PROPOSE_REFUSAL);
}

export async function assertNotVideoAdGroup(tenant_id: string, ad_group_id: string): Promise<void> {
  const live = await checked(tenant_id, `ad group ${ad_group_id}`, () => gadsGetAdGroup(tenant_id, ad_group_id));
  if (live && isVideoAdGroupType(live.type)) throw new ExpectedToolError("google_ads_video_mutate_unsupported", PROPOSE_REFUSAL);
}

export function videoMutateRefusal(channelType: string | undefined | null) {
  return channelType === "VIDEO"
    ? { ok: false as const, code: "google_ads_video_mutate_unsupported", error: VIDEO_MUTATE_UNSUPPORTED }
    : null;
}

export function isVideoAdGroupType(type: string | undefined | null): boolean {
  return typeof type === "string" && type.startsWith("VIDEO_");
}

export function videoAdGroupRefusal(type: string | undefined | null) {
  return isVideoAdGroupType(type) ? videoMutateRefusal("VIDEO") : null;
}
