
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";
import {
  getLibraryAsset,
  getLibraryAssetRow,
  listLibraryAssets,
  signedDownloadUrl,
} from "@/services/creators/library";
import { metaCreateLibraryAd } from "@/services/tools/meta-ads/write/create_library_ad";
import {
  BLOCK_REASON_TEXT,
  resolveMetaAdCapability,
} from "@/services/tools/meta-ads/write/_library-ad-capability";

const AssetParam = z.object({ asset_id: z.string().uuid() });

const RIGHTS_EXPIRED_MESSAGE =
  "The ad rights on this video have ended, so Zavi will not add it to your Meta ad account. Talk to the creator if you want to run it again.";

function rightsExpired(rights_end_at: string): boolean {
  return Date.parse(rights_end_at) <= Date.now();
}

const MetaAdBody = z.object({
  ad_set_id: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(100).optional(),
  message: z.string().trim().min(1).max(2000).optional(),
});

function badAssetId(res: Response): void {
  res.status(400).json({ error: { code: "bad_asset_id", message: "asset id is required" } });
}

function notFound(res: Response): void {
  res
    .status(404)
    .json({ error: { code: "library_asset_not_found", message: "Library item not found." } });
}

export async function getCreatorLibrary(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const assets = await listLibraryAssets(asTenantId(auth.tenant_id));
  res.json({ assets });
}

export async function getCreatorLibraryAsset(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const parsed = AssetParam.safeParse({ asset_id: req.params.asset_id });
  if (!parsed.success) return badAssetId(res);
  const asset = await getLibraryAsset(asTenantId(auth.tenant_id), parsed.data.asset_id);
  if (!asset) return notFound(res);
  res.json(asset);
}

export async function getCreatorLibraryDownload(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const parsed = AssetParam.safeParse({ asset_id: req.params.asset_id });
  if (!parsed.success) return badAssetId(res);
  const signed = await signedDownloadUrl(asTenantId(auth.tenant_id), parsed.data.asset_id);
  if (!signed) return notFound(res);
  res.json(signed);
}

export async function getCreatorLibraryMetaEligibility(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const parsed = AssetParam.safeParse({ asset_id: req.params.asset_id });
  if (!parsed.success) return badAssetId(res);

  const tid = asTenantId(auth.tenant_id);
  const row = await getLibraryAssetRow(tid, parsed.data.asset_id);
  if (!row) return notFound(res);

  if (row.meta_ad_id) {
    res.json({
      eligible: false,
      reason_code: "already_created",
      reason: "This video is already in your Meta ad account as a paused ad.",
      download_available: true,
      meta: {
        ad_account_id: row.meta_ad_account_id,
        video_id: row.meta_video_id,
        ad_id: row.meta_ad_id,
      },
    });
    return;
  }

  if (rightsExpired(row.rights_end_at)) {
    res.json({
      eligible: false,
      reason_code: "rights_expired",
      reason: RIGHTS_EXPIRED_MESSAGE,
      download_available: true,
    });
    return;
  }

  const cap = await resolveMetaAdCapability(auth.tenant_id);
  if (!cap.ok) {
    res.json({
      eligible: false,
      reason_code: cap.reason_code,
      reason: cap.reason,
      download_available: true,
    });
    return;
  }
  res.json({
    eligible: true,
    download_available: true,
    ad_account_id: cap.ad_account_id,
    page_id: cap.page_id,
    page_name: cap.page_name,
    ad_sets: cap.ad_sets,
  });
}

export async function postCreatorLibraryMetaAd(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const params = AssetParam.safeParse({ asset_id: req.params.asset_id });
  if (!params.success) return badAssetId(res);
  const body = MetaAdBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({
      error: {
        code: "bad_meta_ad_request",
        message: "Pick the ad set this video should go into.",
      },
    });
    return;
  }

  const tid = asTenantId(auth.tenant_id);
  const row = await getLibraryAssetRow(tid, params.data.asset_id);
  if (!row) return notFound(res);

  if (row.meta_ad_id) {
    res.status(409).json({
      error: {
        code: "meta_ad_already_created",
        message: "This video is already in your Meta ad account as a paused ad.",
      },
      meta: {
        ad_account_id: row.meta_ad_account_id,
        video_id: row.meta_video_id,
        ad_id: row.meta_ad_id,
      },
    });
    return;
  }

  if (rightsExpired(row.rights_end_at)) {
    res.status(409).json({
      error: { code: "rights_expired", message: RIGHTS_EXPIRED_MESSAGE },
      download_available: true,
    });
    return;
  }

  const signed = await signedDownloadUrl(tid, params.data.asset_id);
  if (!signed) return notFound(res);

  try {
    const result = await metaCreateLibraryAd(
      auth.tenant_id,
      {
        ad_set_id: body.data.ad_set_id,
        video_url: signed.url,
        name: body.data.name ?? `Zavi creator ${row.utm_campaign}`,
        message: body.data.message,
        tracking_tag: row.utm_campaign,
        resume_video_id: row.meta_video_id ?? undefined,
      },
      {
        onVideoUploaded: async (video_id, ad_account_id) => {
          await tenantClient(tid)
            .from("creator_library_assets")
            .update({ meta_video_id: video_id, meta_ad_account_id: ad_account_id })
            .eq("id", row.id);
        },
      },
    );

    await tenantClient(tid)
      .from("creator_library_assets")
      .update({
        meta_ad_account_id: result.ad_account_id,
        meta_video_id: result.video_id,
        meta_ad_id: result.ad_id,
        meta_ad_set_id: body.data.ad_set_id,
      })
      .eq("id", row.id);

    res.json({
      ad_account_id: result.ad_account_id,
      video_id: result.video_id,
      creative_id: result.creative_id,
      ad_id: result.ad_id,
      status: result.status,
      rights_end_at: row.rights_end_at,
      note: "The ad is paused. Nothing spends until you turn it on in Meta Ads Manager. Zavi pauses it again when the rights end.",
    });
  } catch (e) {
    if (e instanceof ExpectedToolError) {
      const isRefusal = Object.keys(BLOCK_REASON_TEXT).some(
        (code) => e.code === `meta_ads_${code}`,
      );
      res.status(isRefusal ? 409 : 502).json({
        error: { code: e.code, message: e.message },
        download_available: true,
      });
      return;
    }
    throw e;
  }
}
