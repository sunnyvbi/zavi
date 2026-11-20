import { asTenantId, tenantClient } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";

export async function isKnownGeneratedVideo(tenantId: string, advertiserId: string, videoId: string): Promise<boolean> {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("tiktok_ad_video_uploads").select("source_key")
    .eq("advertiser_id", advertiserId).eq("video_id", videoId)
    .like("source_key", "zavi:%").limit(1);
  if (error) throw new ExpectedToolError("tiktok_ads_video_provenance_unreadable", "The replacement video's source could not be checked. Try again before reviewing its AI disclosure.");
  return (data ?? []).some(row => row !== null && typeof row === "object" && "source_key" in row && typeof row.source_key === "string" && row.source_key.startsWith("zavi:"));
}
