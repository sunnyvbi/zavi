
import { createHash } from "node:crypto";
import { asTenantId, tenantClient } from "@/services/tenant-client";

export type VideoSource = { artifact_id: string } | { upload_path: string } | { url: string };

export function videoSourceKey(src: VideoSource): string {
  if ("artifact_id" in src) return `zavi:${src.artifact_id.toLowerCase()}`;
  if ("upload_path" in src) return `upload:${src.upload_path.toLowerCase()}`;
  return `link:${createHash("sha256").update(src.url).digest("hex")}`;
}

export interface VideoUploadStore {
  find(advertiserId: string, key: string): Promise<string | null>;
  remember(advertiserId: string, key: string, videoId: string): Promise<void>;
}

export function videoUploadStore(tenantId: string): VideoUploadStore {
  const db = () => tenantClient(asTenantId(tenantId));
  return {
    async find(advertiserId, key) {
      try {
        const { data, error } = await db()
          .from("tiktok_ad_video_uploads")
          .select("video_id")
          .eq("advertiser_id", advertiserId)
          .eq("source_key", key)
          .maybeSingle<{ video_id: string }>();
        if (error) throw new Error(error.message);
        return data?.video_id ?? null;
      } catch (e) {
        console.warn(`[tiktok-launch] uploaded-video read failed for ${tenantId}; uploading as before: ${(e as Error).message}`);
        return null;
      }
    },
    async remember(advertiserId, key, videoId) {
      try {
        const { error } = await db()
          .from("tiktok_ad_video_uploads")
          .upsert({ advertiser_id: advertiserId, source_key: key, video_id: videoId, updated_at: new Date().toISOString() }, { onConflict: "tenant_id,advertiser_id,source_key" });
        if (error) throw new Error(error.message);
      } catch (e) {
        console.warn(`[tiktok-launch] uploaded video ${videoId} not remembered for ${tenantId}; a retry uploads again: ${(e as Error).message}`);
      }
    },
  };
}
