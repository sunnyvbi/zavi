
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { asTenantId, tenantRpc } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";
import type { ToolContext } from "@/services/tools/types";
import {
  getLibraryAssetRow,
  setLibraryAssetYoutubeVideoId,
} from "@/services/creators/library";
import { gadsSearch } from "@/services/tools/google-ads/_client";
import {
  videoFormatForAdGroupType,
  youtubeVideoIdFrom,
} from "@/services/tools/google-ads/write/_video-formats";
import { googleProposeVideoAdTool } from "@/services/tools/google-ads/write/propose_video_ad";

const AssetParam = z.object({ asset_id: z.string().uuid() });

const RIGHTS_EXPIRED_MESSAGE =
  "The ad rights on this video have ended, so Zavi will not put it into your Google Ads account. Talk to the creator if you want to run it again.";

const NO_VIDEO_ID_MESSAGE =
  "Add the YouTube video id first: upload this video to your own YouTube channel, then paste the id or the watch URL here.";

function rightsExpired(rights_end_at: string): boolean {
  return Date.parse(rights_end_at) <= Date.now();
}

function badAssetId(res: Response): void {
  res.status(400).json({ error: { code: "bad_asset_id", message: "asset id is required" } });
}

function notFound(res: Response): void {
  res
    .status(404)
    .json({ error: { code: "library_asset_not_found", message: "Library item not found." } });
}

const YoutubeVideoBody = z.object({
  youtube_video: z.string().trim().min(1).max(500),
});

export async function postCreatorLibraryYoutubeVideo(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const params = AssetParam.safeParse({ asset_id: req.params.asset_id });
  if (!params.success) return badAssetId(res);

  const body = YoutubeVideoBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({
      error: {
        code: "bad_youtube_video_id",
        message: "Paste the YouTube video id, or the link to the video.",
      },
    });
    return;
  }

  const tid = asTenantId(auth.tenant_id);
  const row = await getLibraryAssetRow(tid, params.data.asset_id);
  if (!row) return notFound(res);

  if (rightsExpired(row.rights_end_at)) {
    res.status(409).json({
      error: { code: "rights_expired", message: RIGHTS_EXPIRED_MESSAGE },
      download_available: true,
    });
    return;
  }

  const youtube_video_id = youtubeVideoIdFrom(body.data.youtube_video);
  if (!youtube_video_id) {
    res.status(400).json({
      error: {
        code: "bad_youtube_video_id",
        message:
          "That is not a YouTube video. Paste the 11-character video id, or the link to the video (youtube.com/watch?v=…, youtu.be/…, or a /shorts/ link).",
      },
    });
    return;
  }

  const updated = await setLibraryAssetYoutubeVideoId(
    tid,
    params.data.asset_id,
    youtube_video_id,
  );
  if (!updated) return notFound(res);

  res.json({
    youtube_video_id: updated.youtube_video_id,
    note: "Saved. Nothing has been sent to Google Ads yet.",
  });
}

type AdGroupRow = {
  adGroup?: { id?: string; name?: string; status?: string; type?: string };
  campaign?: { id?: string; name?: string; status?: string };
};

export type YoutubeAdGroupOption = {
  id: string;
  name: string;
  status: string | null;
  format: string;
  campaign_name: string | null;
};

const AD_GROUP_QUERY = `
  SELECT
    ad_group.id,
    ad_group.name,
    ad_group.status,
    ad_group.type,
    campaign.id,
    campaign.name,
    campaign.status
  FROM ad_group
  WHERE ad_group.type IN (
      'VIDEO_TRUE_VIEW_IN_STREAM',
      'VIDEO_NON_SKIPPABLE_IN_STREAM',
      'VIDEO_BUMPER',
      'VIDEO_TRUE_VIEW_IN_DISPLAY',
      'VIDEO_RESPONSIVE'
    )
    AND ad_group.status != 'REMOVED'
    AND campaign.status != 'REMOVED'
  LIMIT 200
`;

async function listVideoAdGroups(tenant_id: string): Promise<YoutubeAdGroupOption[]> {
  const rows = (await gadsSearch(tenant_id, AD_GROUP_QUERY)) as AdGroupRow[];
  const out: YoutubeAdGroupOption[] = [];
  for (const r of rows) {
    const id = r.adGroup?.id;
    const type = r.adGroup?.type;
    if (!id || !type) continue;
    const format = videoFormatForAdGroupType(type);
    if (!format) continue;
    out.push({
      id,
      name: r.adGroup?.name ?? id,
      status: r.adGroup?.status ?? null,
      format,
      campaign_name: r.campaign?.name ?? null,
    });
  }
  return out;
}

export async function getCreatorLibraryYoutubeEligibility(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const params = AssetParam.safeParse({ asset_id: req.params.asset_id });
  if (!params.success) return badAssetId(res);

  const tid = asTenantId(auth.tenant_id);
  const row = await getLibraryAssetRow(tid, params.data.asset_id);
  if (!row) return notFound(res);

  if (rightsExpired(row.rights_end_at)) {
    res.json({
      eligible: false,
      reason_code: "rights_expired",
      reason: RIGHTS_EXPIRED_MESSAGE,
      download_available: true,
      youtube_video_id: row.youtube_video_id,
    });
    return;
  }

  res.json({
    eligible: false,
    reason_code: "google_ads_video_create_unsupported",
    reason: YOUTUBE_EXIT_UNAVAILABLE,
    download_available: true,
    youtube_video_id: row.youtube_video_id,
  });
}

export const YOUTUBE_EXIT_UNAVAILABLE =
  "Google's Ads API can no longer add ads to YouTube video campaigns, so Zavi can't propose this one. Download the video and add it in Google Ads yourself.";

const YoutubeAdBody = z.object({
  ad_group_id: z.string().regex(/^[0-9]+$/),
  final_url: z.string().url().max(2000).optional(),
  headline: z.string().trim().min(1).max(100).optional(),
  long_headline: z.string().trim().min(1).max(90).optional(),
  description1: z.string().trim().min(1).max(90).optional(),
  description2: z.string().trim().min(1).max(90).optional(),
  call_to_action: z.string().trim().min(1).max(10).optional(),
  name: z.string().trim().min(1).max(100).optional(),
});

export function finalUrlWithTrackingTag(final_url: string, tag: string): string {
  try {
    const url = new URL(final_url);
    if (!url.searchParams.has("utm_campaign")) {
      url.searchParams.set("utm_campaign", tag);
    }
    return url.toString();
  } catch {
    return final_url;
  }
}

const FORM_ERROR_CODES = new Set([
  "google_ads_invalid_create_body",
  "google_ads_video_final_url_required",
  "google_ads_video_in_feed_copy_required",
  "google_ads_video_responsive_copy_required",
]);

export async function postCreatorLibraryYoutubeAd(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const params = AssetParam.safeParse({ asset_id: req.params.asset_id });
  if (!params.success) return badAssetId(res);

  const body = YoutubeAdBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({
      error: {
        code: "bad_youtube_ad_request",
        message: "Pick the video ad group this video should go into.",
      },
    });
    return;
  }

  const tid = asTenantId(auth.tenant_id);
  const row = await getLibraryAssetRow(tid, params.data.asset_id);
  if (!row) return notFound(res);

  if (rightsExpired(row.rights_end_at)) {
    res.status(409).json({
      error: { code: "rights_expired", message: RIGHTS_EXPIRED_MESSAGE },
      download_available: true,
    });
    return;
  }

  if (!row.youtube_video_id) {
    res.status(409).json({
      error: { code: "youtube_video_id_missing", message: NO_VIDEO_ID_MESSAGE },
      download_available: true,
    });
    return;
  }

  let adGroups: YoutubeAdGroupOption[];
  try {
    adGroups = await listVideoAdGroups(auth.tenant_id);
  } catch (e) {
    if (e instanceof ExpectedToolError) {
      res.status(409).json({
        error: { code: e.code, message: e.message },
        download_available: true,
      });
      return;
    }
    throw e;
  }
  const adGroup = adGroups.find((g) => g.id === body.data.ad_group_id);
  if (!adGroup) {
    res.status(400).json({
      error: {
        code: "youtube_ad_group_not_found",
        message:
          "That video ad group is not in your Google Ads account any more. Reload and pick again.",
      },
    });
    return;
  }

  const final_url = body.data.final_url
    ? finalUrlWithTrackingTag(body.data.final_url, row.utm_campaign)
    : undefined;

  const ctx: ToolContext = {
    tenant_id: auth.tenant_id,
    log: () => {},
    emit_decision: async (decision_class, decisionBody) => {
      const { data, error } = await tenantRpc(tid, "emit_decision", {
        p_agent_run_id: null,
        p_decision_class: decision_class,
        p_body: decisionBody as object,
      });
      if (error) throw new Error(error.message);
      return data as string;
    },
  };

  try {
    const result = (await googleProposeVideoAdTool.execute(ctx, {
      ad_group_id: body.data.ad_group_id,
      format: adGroup.format,
      youtube_video_ids: [row.youtube_video_id],
      ...(final_url ? { final_url } : {}),
      headlines: body.data.headline ? [body.data.headline] : [],
      long_headlines: body.data.long_headline ? [body.data.long_headline] : [],
      descriptions: [body.data.description1, body.data.description2].filter(
        (d): d is string => Boolean(d),
      ),
      ...(body.data.call_to_action ? { call_to_action: body.data.call_to_action } : {}),
      rationale: `Creator video from the Creators Library (tracking tag ${row.utm_campaign}). Ad rights run to ${row.rights_end_at}.`,
      name: body.data.name ?? `Zavi creator ${row.utm_campaign}`,
      about: "An approved creator video the business already paid for and holds ad rights to.",
    })) as { decision_id: string; decision_class: string; will_auto_apply: boolean };

    res.json({
      decision_id: result.decision_id,
      decision_class: result.decision_class,
      will_auto_apply: result.will_auto_apply,
      youtube_video_id: row.youtube_video_id,
      ad_group_id: adGroup.id,
      ad_group_name: adGroup.name,
      format: adGroup.format,
      tracking_tag: row.utm_campaign,
      rights_end_at: row.rights_end_at,
      note: "Proposed, not created. Approve it in Zavi and Google Ads adds the ad PAUSED. Nothing spends until you enable it in Google Ads. Zavi does not pause this one for you when the rights end, so take it down yourself.",
    });
  } catch (e) {
    if (e instanceof ExpectedToolError) {
      res.status(FORM_ERROR_CODES.has(e.code) ? 400 : 409).json({
        error: { code: e.code, message: e.message },
        download_available: true,
      });
      return;
    }
    throw e;
  }
}
