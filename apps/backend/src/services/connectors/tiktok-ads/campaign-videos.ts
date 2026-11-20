import { z } from "zod";
import { ExpectedToolError } from "@/services/tools/types";
import { assertSafeUrl, SsrfBlockedError } from "@/services/onboarding/enrichment/url-guard";
import { ensureAdAccounts } from "./ad-accounts";
import { tiktokAdsAccount, tt } from "./composio-read";
import { readLaunchVideo, uploadLaunchVideo, type TiktokVideo } from "./launch-readiness";
import { videoRefusal } from "./launch-schema";
import { signedUploadedVideoUrl, signedZaviVideoUrl, UPLOADED_VIDEO_PATH_RE } from "./zavi-videos";
import { videoSourceKey, videoUploadStore } from "./video-uploads";

export const campaignVideoSourceSchema = z.object({
  video_artifact_id: z.string().uuid().optional(),
  video_upload_path: z.string().regex(UPLOADED_VIDEO_PATH_RE).optional(),
  video_url: z.string().url().max(2000).optional(),
}).strict().refine((v) => [v.video_artifact_id, v.video_upload_path, v.video_url].filter(Boolean).length === 1, "Choose exactly one video source.");

export type CampaignVideoSource = z.infer<typeof campaignVideoSourceSchema>;
export type CampaignLibraryVideo = { video_id: string; name: string; preview_url: string | null };

async function ownedAdvertiser(tenantId: string, advertiserId: string) {
  if (!/^\d{1,32}$/.test(advertiserId)) throw new ExpectedToolError("tiktok_ads_unknown_account", "Choose a saved TikTok ad account.");
  const state = await ensureAdAccounts(tenantId);
  if (!state.connected || !state.accounts.some((a) => a.advertiser_id === advertiserId)) {
    throw new ExpectedToolError("tiktok_ads_unknown_account", "That TikTok ad account is not connected to this workspace.");
  }
  return tiktokAdsAccount(tenantId);
}

export async function listCampaignVideos(tenantId: string, advertiserId: string, options: { page?: number } = {}): Promise<{ videos: CampaignLibraryVideo[]; truncated: boolean; page: number; next_page: number | null }> {
  const page = z.number().int().min(1).max(10000).parse(options.page ?? 1);
  const account = await ownedAdvertiser(tenantId, advertiserId);
  const data = await tt(account, `/file/video/ad/search/?advertiser_id=${encodeURIComponent(advertiserId)}&page=${page}&page_size=100`);
  const parsed = z.object({
    list: z.array(z.object({ video_id: z.string().min(1), file_name: z.string().nullish(), video_cover_url: z.string().nullish() })),
    page_info: z.object({ total_page: z.number().int().nonnegative().optional() }).optional(),
  }).safeParse(data);
  if (!parsed.success) throw new ExpectedToolError("tiktok_ads_videos_unreadable", "TikTok's video library could not be read. Try again.");
  const hasMore = parsed.data.page_info?.total_page === undefined ? parsed.data.list.length >= 100 : parsed.data.page_info.total_page > page;
  return {
    videos: parsed.data.list.map((v) => ({ video_id: v.video_id, name: v.file_name || v.video_id, preview_url: /^https:\/\//i.test(v.video_cover_url ?? "") ? v.video_cover_url! : null })),
    truncated: hasMore,
    page,
    next_page: hasMore && page < 10000 ? page + 1 : null,
  };
}

export async function prepareCampaignVideo(tenantId: string, advertiserId: string, input: CampaignVideoSource): Promise<TiktokVideo & { ai_generated: true | null }> {
  const args = campaignVideoSourceSchema.parse(input);
  const account = await ownedAdvertiser(tenantId, advertiserId);
  let url: string;
  let filename: string;
  if (args.video_artifact_id) {
    const signed = await signedZaviVideoUrl(tenantId, args.video_artifact_id);
    url = signed.url; filename = signed.filename;
  } else if (args.video_upload_path) {
    const signed = await signedUploadedVideoUrl(tenantId, args.video_upload_path);
    url = signed.url; filename = signed.filename;
  } else {
    try {
      const safe = await assertSafeUrl(args.video_url!);
      url = safe.toString(); filename = safe.pathname.split("/").pop() || "video.mp4";
    } catch (error) {
      if (error instanceof SsrfBlockedError) throw new ExpectedToolError("tiktok_ads_video_url_unsafe", "Use a public HTTPS link to the video file.");
      throw error;
    }
  }
  const store = videoUploadStore(tenantId);
  const key = videoSourceKey(args.video_artifact_id ? { artifact_id: args.video_artifact_id } : args.video_upload_path ? { upload_path: args.video_upload_path } : { url });
  let id = await store.find(advertiserId, key);
  let measured = id ? await readLaunchVideo(account, advertiserId, id) : null;
  if (!measured) {
    id = await uploadLaunchVideo(account, advertiserId, url, `zavi-${filename}`);
    await store.remember(advertiserId, key, id);
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!measured) measured = await readLaunchVideo(account, advertiserId, id!);
    if (measured && measured.width !== null && measured.height !== null && measured.duration_s !== null && measured.allowed_placements !== null) break;
    measured = null;
    if (attempt < 2 && process.env.NODE_ENV !== "test") await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (!measured) throw new ExpectedToolError("tiktok_ads_video_unreadable", "TikTok has not finished processing this video. Try again in a minute.");
  const refusal = videoRefusal(measured);
  if (refusal) throw refusal;
  return { ...measured, ai_generated: args.video_artifact_id ? true : null };
}
