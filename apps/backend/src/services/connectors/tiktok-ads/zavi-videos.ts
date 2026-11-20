
import { asTenantId, tenantClient, tenantStorage } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";

export const ZAVI_VIDEO_BUCKET = "launch-video-artifacts";
const SIGNED_URL_TTL_S = 60 * 60;
const LIST_LIMIT = 20;

export type ZaviVideo = { artifact_id: string; filename: string; created_at: string | null };

type Row = { id: string; storage_path: string; bucket: string | null; filename: string; mime: string | null; created_at: string | null };

const prefixOf = (tenantId: string) => `${tenantId.toLowerCase()}/`;

export async function listZaviVideos(tenantId: string): Promise<ZaviVideo[]> {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("run_artifacts")
    .select("id, storage_path, bucket, filename, mime, created_at")
    .eq("bucket", ZAVI_VIDEO_BUCKET)
    .eq("mime", "video/mp4")
    .order("created_at", { ascending: false })
    .limit(LIST_LIMIT);
  if (error) throw new ExpectedToolError("tiktok_ads_videos_unreadable", `Zavi's videos could not be read right now (${error.message}).`);
  return ((data ?? []) as Row[])
    .filter((r) => r.storage_path.startsWith(prefixOf(tenantId)))
    .map((r) => ({ artifact_id: r.id, filename: r.filename, created_at: r.created_at }));
}

export async function signedZaviVideoUrl(tenantId: string, artifactId: string): Promise<{ url: string; filename: string }> {
  const tid = asTenantId(tenantId);
  const { data, error } = await tenantClient(tid)
    .from("run_artifacts")
    .select("id, storage_path, bucket, filename, mime, created_at")
    .eq("id", artifactId)
    .limit(1);
  if (error) throw new ExpectedToolError("tiktok_ads_videos_unreadable", `That video could not be looked up right now (${error.message}).`);
  const row = ((data ?? []) as Row[])[0];
  if (!row || row.bucket !== ZAVI_VIDEO_BUCKET || row.mime !== "video/mp4" || !row.storage_path.startsWith(prefixOf(tenantId))) {
    throw new ExpectedToolError("tiktok_ads_no_usable_video", `No Zavi video ${artifactId} in this workspace. Fix: pick one from tiktok_ads__launch_readiness, or make one with AI UGC Videos.`);
  }
  const signed = await tenantStorage(tid).from(ZAVI_VIDEO_BUCKET).createSignedUrl(row.storage_path, SIGNED_URL_TTL_S);
  if (signed.error || !signed.data?.signedUrl) {
    throw new ExpectedToolError("tiktok_ads_videos_unreadable", "Zavi's copy of that video could not be opened right now. Try again in a minute.");
  }
  return { url: signed.data.signedUrl, filename: row.filename };
}

export const UPLOADED_VIDEO_BUCKET = "launch-video-media";
export const UPLOADED_VIDEO_PATH_RE = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.mp4$/;

export async function signedUploadedVideoUrl(tenantId: string, path: string): Promise<{ url: string; filename: string }> {
  if (!UPLOADED_VIDEO_PATH_RE.test(path)) {
    throw new ExpectedToolError("tiktok_ads_no_usable_video", "video_upload_path must look like <workspace id>/<uuid>.mp4, the path the upload returned.");
  }
  if (!path.toLowerCase().startsWith(prefixOf(tenantId))) {
    throw new ExpectedToolError("tiktok_ads_no_usable_video", "That uploaded video is not in this workspace.");
  }
  const signed = await tenantStorage(asTenantId(tenantId)).from(UPLOADED_VIDEO_BUCKET).createSignedUrl(path, SIGNED_URL_TTL_S);
  if (signed.error || !signed.data?.signedUrl) {
    throw new ExpectedToolError("tiktok_ads_videos_unreadable", "The uploaded video could not be opened right now. Try again in a minute.");
  }
  return { url: signed.data.signedUrl, filename: path.split("/").pop() ?? "upload.mp4" };
}
