import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { refuseIfChannelPlanLocked } from "@/services/growth/preview-plan";
import { assertSpendWritesOn } from "@/services/channels/lock";
import { ExpectedToolError } from "@/services/tools/types";
import { savedAdvertiser } from "@/services/tools/tiktok-ads/propose_changes";
import { tiktokAdsProposeLaunchTool } from "@/services/tools/tiktok-ads/launch";
import { readCampaignSettings } from "@/services/connectors/tiktok-ads/campaign-settings";
import { requestCampaignCreation, requestCampaignEdit } from "@/services/connectors/tiktok-ads/campaign-requests";
import { listCampaignVideos, prepareCampaignVideo } from "@/services/connectors/tiktok-ads/campaign-videos";
import { readLaunchReadiness } from "@/services/connectors/tiktok-ads/launch-readiness";
import { tiktokAdsAccount } from "@/services/connectors/tiktok-ads/composio-read";
import { readTiktokLanguages } from "@/services/connectors/tiktok-ads/targeting";
import { adsNoFrictionEnabled } from "@/services/growth/ads-no-friction-flag";
import { CampaignFilingOutcomeUnknown } from "@/services/connectors/tiktok-ads/campaign-request-errors";
import { readCampaignAudiences, readCampaignInterests } from "@/services/connectors/tiktok-ads/campaign-advanced";

const id = z.string().regex(/^\d{1,32}$/);
const requestId = z.string().regex(/^[A-Za-z0-9_.:-]{8,200}$/);
const editInput = z.object({
  advertiser_id: id, campaign_id: id, level: z.enum(["campaign", "ad_group", "ad"]),
  object_id: id, revision: z.string().min(1).max(128), changes: z.record(z.string(), z.unknown()), request_id: requestId,
}).strict();
const videoInput = z.object({
  advertiser_id: id, request_id: requestId, video_artifact_id: z.string().uuid().optional(),
  video_upload_path: z.string().max(200).optional(), video_url: z.string().url().max(2000).optional(),
}).strict().refine(v => [v.video_artifact_id, v.video_upload_path, v.video_url].filter(Boolean).length === 1, "Choose one video.");

function failure(res: Response, error: unknown) {
  if (error instanceof CampaignFilingOutcomeUnknown) {
    res.status(503).json({ error: { code: "tiktok_campaign_filing_unknown", message: error.message } }); return;
  }
  if (res.locals) res.locals.idempotencyRelease = true;
  if (error instanceof z.ZodError) { res.status(400).json({ error: { code: "validation", message: error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") } }); return; }
  if (error instanceof ExpectedToolError) { res.status(409).json({ error: { code: error.code, message: error.message } }); return; }
  res.status(503).json({ error: { code: "tiktok_campaign_unavailable", message: "TikTok campaign settings could not be confirmed. Refresh before retrying." } });
}

async function writeAuth(req: Request, res: Response) {
  const auth = await requireAuth(req, res);
  if (!auth) return null;
  if (auth.tenant_overridden) { res.status(403).json({ error: { code: "tenant_override_forbidden", message: "Switch to your own workspace to edit campaigns." } }); return null; }
  if (!await requireTenantRole(auth, ["owner", "admin"], res)) return null;
  const locked = await refuseIfChannelPlanLocked(auth.tenant_id, "tiktok_ads");
  if (locked) { res.status(403).json(locked.body); return null; }
  const key = req.get("Idempotency-Key");
  if (!key || !requestId.safeParse(key).success || req.body?.request_id !== key) {
    res.status(400).json({ error: { code: "idempotency_required", message: "Refresh the campaign editor and try again." } }); return null;
  }
  return auth;
}

export async function tiktokCampaignDetail(req: Request, res: Response) {
  const auth = await requireAuth(req, res); if (!auth) return;
  try {
    const campaignId = id.parse(req.params.campaignId), advertiserId = id.parse(req.query.advertiser_id);
    res.setHeader("Cache-Control", "private, no-store");
    res.json(await readCampaignSettings(auth.tenant_id, advertiserId, campaignId));
  } catch (e) { failure(res, e); }
}

export async function tiktokCampaignOptions(req: Request, res: Response) {
  const auth = await requireAuth(req, res); if (!auth) return;
  try {
    const advertiserId = id.optional().parse(req.query.advertiser_id);
    const saved = await savedAdvertiser(auth.tenant_id, advertiserId);
    const readiness = await readLaunchReadiness(auth.tenant_id, { advertiser_id: saved.advertiser_id });
    const account = await tiktokAdsAccount(auth.tenant_id);
    const [languages, library, endDate, audiences, interests] = await Promise.allSettled([
      readTiktokLanguages(account, saved.advertiser_id), listCampaignVideos(auth.tenant_id, saved.advertiser_id), adsNoFrictionEnabled(),
      readCampaignAudiences(account, saved.advertiser_id), readCampaignInterests(account, saved.advertiser_id),
    ]);
    res.setHeader("Cache-Control", "private, no-store");
    res.json({
      advertiser: { id: saved.advertiser_id, name: saved.name, currency: saved.currency, timezone: readiness.advertiser?.timezone ?? null },
      identities: readiness.identities, zavi_videos: readiness.videos, locations: readiness.allowed_locations,
      videos: library.status === "fulfilled" ? library.value.videos : [],
      videos_truncated: library.status === "fulfilled" && library.value.truncated,
      videos_next_page: library.status === "fulfilled" ? library.value.next_page : null,
      audiences: audiences.status === "fulfilled" ? audiences.value.options : [], audiences_error: audiences.status === "rejected",
      audiences_truncated: audiences.status === "fulfilled" && audiences.value.truncated,
      interests: interests.status === "fulfilled" ? interests.value : [], interests_error: interests.status === "rejected",
      videos_error: library.status === "rejected", languages: languages.status === "fulfilled" ? languages.value : [], languages_error: languages.status === "rejected",
      blockers: readiness.blockers.filter(b => b.code !== "tiktok_ads_no_usable_video"), notes: readiness.notes,
      end_date_enabled: endDate.status === "fulfilled" && endDate.value,
    });
  } catch (e) { failure(res, e); }
}

export async function tiktokCampaignVideoLibrary(req: Request, res: Response) {
  const auth = await requireAuth(req, res); if (!auth) return;
  try {
    const advertiserId = id.parse(req.query.advertiser_id);
    const page = z.coerce.number().int().min(1).max(10000).default(1).parse(req.query.page);
    res.setHeader("Cache-Control", "private, no-store");
    res.json(await listCampaignVideos(auth.tenant_id, advertiserId, { page }));
  } catch (e) { failure(res, e); }
}

export async function tiktokCampaignCreate(req: Request, res: Response) {
  try {
    const auth = await writeAuth(req, res); if (!auth) return;
    await assertSpendWritesOn("tiktok_ads", "TikTok Ads", "tiktok_ads");
    const { request_id: _requestId, ...raw } = req.body;
    id.parse(raw.advertiser_id);
    const inputs = tiktokAdsProposeLaunchTool.input_schema.parse({ ...raw, rationale: "Campaign created from the editor." }) as Record<string, unknown>;
    res.json(await requestCampaignCreation(auth.tenant_id, auth.user_id, inputs));
  } catch (e) { failure(res, e); }
}

export async function tiktokCampaignEdit(req: Request, res: Response) {
  try {
    const auth = await writeAuth(req, res); if (!auth) return;
    const { request_id: _requestId, ...input } = editInput.parse(req.body);
    res.json(await requestCampaignEdit(auth.tenant_id, auth.user_id, input));
  } catch (e) { failure(res, e); }
}

export async function tiktokCampaignVideo(req: Request, res: Response) {
  try {
    const auth = await writeAuth(req, res); if (!auth) return;
    const { advertiser_id, request_id: _requestId, ...input } = videoInput.parse(req.body);
    res.json(await prepareCampaignVideo(auth.tenant_id, advertiser_id, input));
  } catch (e) { failure(res, e); }
}
