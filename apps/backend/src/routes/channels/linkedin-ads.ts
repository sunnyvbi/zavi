import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { checkAgentTier } from "@/services/agents/entitlement";
import { comingSoonMessage, isChannelLockedStrict } from "@/services/channels/lock";
import { ExpectedToolError } from "@/services/tools/types";
import { logEvent } from "@/services/logging/logEvent";

async function linkedinAdsAuth(req: Request, res: Response, pauseOnly = false) {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return null;
    if ((auth as { tenant_overridden?: boolean }).tenant_overridden) {
      res.status(403).json({ error: { code: "tenant_override_forbidden", message: "Switch to your own workspace to make changes." } });
      return null;
    }
    if (!(await requireTenantRole(auth, ["owner", "admin"], res))) return null;
    if (!pauseOnly && !(await checkAgentTier(auth.tenant_id, "linkedin_ads")).allowed) {
      res.status(403).json({ error: { code: "channel_unavailable", message: "LinkedIn Ads is not available for this workspace." } });
      return null;
    }
    if (!pauseOnly && (await isChannelLockedStrict("linkedin_ads"))) {
      res.status(403).json({ error: { code: "coming_soon", message: comingSoonMessage("LinkedIn Ads") } });
      return null;
    }
    return auth;
  } catch {
    res.status(503).json({ error: { code: "authorization_unavailable", message: "Workspace access could not be checked. Try again." } });
    return null;
  }
}

function linkedinAdsError(res: Response, error: unknown) {
  if (error instanceof z.ZodError) {
    const authored = error.issues.find((i) => i.code === "custom" && i.message && i.message !== "Invalid input")?.message;
    res.status(400).json({ error: { code: "bad_request", message: authored ?? "Check the campaign fields and try again." } });
    return;
  }
  const code = error instanceof ExpectedToolError ? error.code : "linkedin_ads_unavailable";
  if (!(error instanceof ExpectedToolError)) {
    void logEvent({ level: "error", source: "linkedin-ads", code: "linkedin_ads.unexpected_error", message: error instanceof Error ? error.message : String(error) });
  }
  const status = code === "linkedin_ads_not_found" || code === "linkedin_ads_campaign_not_found" ? 404
    : code === "linkedin_ads_conflict" || code === "linkedin_ads_campaign_not_active" || code === "linkedin_ads_pause_pending" ? 409
    : code === "linkedin_ads_campaign_active" || code === "linkedin_ads_campaign_not_restartable" || code === "linkedin_ads_resume_pending" ? 409
    : code === "linkedin_ads_archive_pending" || code === "linkedin_ads_group_status_pending" || code === "linkedin_ads_ad_status_pending" || code === "linkedin_ads_duplicate_pending" ? 409
    : code === "linkedin_ads_campaign_not_archivable" || code === "linkedin_ads_group_ended" || code === "linkedin_ads_group_status_same" ? 409
    : code === "linkedin_ads_last_live_ad" || code === "linkedin_ads_ad_status_same" || code === "linkedin_ads_ad_not_switchable" ? 409
    : code === "linkedin_ads_group_not_found" || code === "linkedin_ads_ad_not_found" ? 404
    : code === "linkedin_ads_default_group" || code === "linkedin_ads_account_not_in_use" ? 422
    : code === "linkedin_ads_end_date_passed" || code === "linkedin_ads_end_date_required" || code === "linkedin_ads_wallet_campaign" ? 422
    : code === "linkedin_ads_post_unreadable" || code === "linkedin_ads_post_page_mismatch" || code === "linkedin_ads_post_not_found" ? 422
    : code === "linkedin_ads_targeting_invalid" ? 422
    : code === "linkedin_ads_audience_unresolved" ? 422
    : code === "linkedin_ads_audience_card_open" ? 409
    : code === "linkedin_ads_writes_off" ? 403
    : code === "linkedin_ads_not_connected" || code === "linkedin_ads_token_revoked" || code === "linkedin_ads_forbidden" ? 403
    : code === "linkedin_ads_setup_unavailable" ? 503
    : 502;
  res.status(status).json({ error: { code, message: error instanceof ExpectedToolError ? error.message : "The request could not be completed. Refresh before trying again." } });
}

export async function linkedinReviewAction(req: Request, res: Response) {
  const auth = await linkedinAdsAuth(req, res); if (!auth) return;
  try {
    const { reviewLinkedInCampaignAction } = await import("@/services/connectors/linkedin-ads/action-review");
    res.json(await reviewLinkedInCampaignAction(auth.tenant_id, req.params.actionId));
  } catch (e) { linkedinAdsError(res, e); }
}

export async function linkedinPrepareAction(req: Request, res: Response) {
  const auth = await linkedinAdsAuth(req, res); if (!auth) return;
  try {
    const { prepareLinkedInCampaignAction } = await import("@/services/connectors/linkedin-ads/action-review");
    res.json(await prepareLinkedInCampaignAction(auth.tenant_id, req.params.actionId, auth.user_id, req.body));
  } catch (e) { linkedinAdsError(res, e); }
}

export async function linkedinCreateAudiences(req: Request, res: Response) {
  const auth = await linkedinAdsAuth(req, res); if (!auth) return;
  try {
    const { createLinkedInAudiencesFromCard } = await import("@/services/connectors/linkedin-ads/saved-audience");
    res.json(await createLinkedInAudiencesFromCard(auth.tenant_id, req.params.actionId, auth.user_id, req.body));
  } catch (e) { linkedinAdsError(res, e); }
}

export async function linkedinSearchTargeting(req: Request, res: Response) {
  const auth = await linkedinAdsAuth(req, res); if (!auth) return;
  try {
    const { searchLinkedinTargeting } = await import("@/services/connectors/linkedin-ads/targeting");
    res.json(await searchLinkedinTargeting(auth.tenant_id, req.params.actionId, req.query));
  } catch (e) { linkedinAdsError(res, e); }
}

export async function linkedinSearchLocations(req: Request, res: Response) {
  const auth = await linkedinAdsAuth(req, res); if (!auth) return;
  try {
    const { searchLinkedinLocations } = await import("@/services/connectors/linkedin-ads/targeting");
    res.json(await searchLinkedinLocations(auth.tenant_id, req.params.actionId, req.query));
  } catch (e) { linkedinAdsError(res, e); }
}

export async function linkedinPreviewPost(req: Request, res: Response) {
  const auth = await linkedinAdsAuth(req, res); if (!auth) return;
  try {
    const { previewLinkedInPost } = await import("@/services/connectors/linkedin-ads/action-review");
    res.json(await previewLinkedInPost(auth.tenant_id, req.params.actionId, req.query));
  } catch (e) { linkedinAdsError(res, e); }
}

export async function linkedinListPosts(req: Request, res: Response) {
  const auth = await linkedinAdsAuth(req, res); if (!auth) return;
  try {
    const { listLinkedInPostsForPicker } = await import("@/services/connectors/linkedin-ads/post-list");
    res.json(await listLinkedInPostsForPicker(auth.tenant_id, req.params.actionId, req.query));
  } catch (e) { linkedinAdsError(res, e); }
}

const ProposePauseInput = z.object({
  campaign_id: z.string().regex(/^\d{1,20}$/),
  account_id: z.string().regex(/^\d{1,20}$/),
});

export async function linkedinProposePause(req: Request, res: Response) {
  const auth = await linkedinAdsAuth(req, res, true); if (!auth) return;
  try {
    const input = ProposePauseInput.parse({ campaign_id: req.params.campaignId, account_id: (req.body as { account_id?: unknown } | undefined)?.account_id });
    const { proposeLinkedInPauseForFounder } = await import("@/services/connectors/linkedin-ads/propose-pause");
    res.status(201).json(await proposeLinkedInPauseForFounder(auth.tenant_id, input));
  } catch (e) { linkedinAdsError(res, e); }
}

const ProposeResumeInput = ProposePauseInput.extend({ run_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

export async function linkedinProposeResume(req: Request, res: Response) {
  const auth = await linkedinAdsAuth(req, res); if (!auth) return;
  try {
    const body = (req.body ?? {}) as { account_id?: unknown; run_until?: unknown };
    const input = ProposeResumeInput.parse({ campaign_id: req.params.campaignId, account_id: body.account_id, ...(body.run_until === undefined ? {} : { run_until: body.run_until }) });
    const { proposeLinkedInResumeForFounder } = await import("@/services/connectors/linkedin-ads/propose-resume");
    res.status(201).json(await proposeLinkedInResumeForFounder(auth.tenant_id, input));
  } catch (e) { linkedinAdsError(res, e); }
}

export async function linkedinFileCampaignDraft(req: Request, res: Response) {
  const auth = await linkedinAdsAuth(req, res); if (!auth) return;
  try {
    const name = (req.body as { name?: unknown } | undefined)?.name;
    const { fileFounderCampaignDraft } = await import("@/services/connectors/linkedin-ads/propose-campaign-draft");
    const out = await fileFounderCampaignDraft(auth.tenant_id, name === undefined || name === "" ? {} : { name });
    res.status(out.reused ? 200 : 201).json(out);
  } catch (e) { linkedinAdsError(res, e); }
}

const numeric = z.string().regex(/^\d{1,20}$/);
const onOff = z.enum(["ACTIVE", "PAUSED"]);
const ProposeArchiveInput = z.object({ campaign_id: numeric, account_id: numeric, mode: z.enum(["archive", "delete"]).optional() });
const ProposeGroupStatusInput = z.object({ group_id: numeric, account_id: numeric, status: onOff });
const ProposeAdStatusInput = z.object({ creative_id: numeric, campaign_id: numeric, account_id: numeric, status: onOff });
const ProposeDuplicateInput = z.object({ source_id: numeric, account_id: numeric, new_name: z.string().trim().min(1).max(255).optional() });

const field = (req: Request, key: string): unknown => (req.body as Record<string, unknown> | undefined)?.[key];
const optional = (v: unknown) => (v === undefined || v === "" || v === null ? undefined : v);

export async function linkedinProposeArchive(req: Request, res: Response) {
  const auth = await linkedinAdsAuth(req, res); if (!auth) return;
  try {
    const input = ProposeArchiveInput.parse({ campaign_id: req.params.campaignId, account_id: field(req, "account_id"), mode: optional(field(req, "mode")) });
    const { proposeLinkedInArchiveForFounder } = await import("@/services/connectors/linkedin-ads/propose-cards");
    res.status(201).json(await proposeLinkedInArchiveForFounder(auth.tenant_id, input));
  } catch (e) { linkedinAdsError(res, e); }
}

export async function linkedinProposeGroupStatus(req: Request, res: Response) {
  const auth = await linkedinAdsAuth(req, res, field(req, "status") === "PAUSED"); if (!auth) return;
  try {
    const input = ProposeGroupStatusInput.parse({ group_id: req.params.groupId, account_id: field(req, "account_id"), status: field(req, "status") });
    const { proposeLinkedInGroupStatusForFounder } = await import("@/services/connectors/linkedin-ads/propose-cards");
    res.status(201).json(await proposeLinkedInGroupStatusForFounder(auth.tenant_id, input));
  } catch (e) { linkedinAdsError(res, e); }
}

export async function linkedinProposeAdStatus(req: Request, res: Response) {
  const auth = await linkedinAdsAuth(req, res, field(req, "status") === "PAUSED"); if (!auth) return;
  try {
    const input = ProposeAdStatusInput.parse({ creative_id: req.params.creativeId, campaign_id: field(req, "campaign_id"), account_id: field(req, "account_id"), status: field(req, "status") });
    const { proposeLinkedInAdStatusForFounder } = await import("@/services/connectors/linkedin-ads/propose-cards");
    res.status(201).json(await proposeLinkedInAdStatusForFounder(auth.tenant_id, input));
  } catch (e) { linkedinAdsError(res, e); }
}

async function proposeDuplicate(req: Request, res: Response, target: "campaign" | "campaign_group", source_id: unknown) {
  const auth = await linkedinAdsAuth(req, res); if (!auth) return;
  try {
    const input = ProposeDuplicateInput.parse({ source_id, account_id: field(req, "account_id"), new_name: optional(field(req, "new_name")) });
    const { proposeLinkedInDuplicateForFounder } = await import("@/services/connectors/linkedin-ads/propose-cards");
    res.status(201).json(await proposeLinkedInDuplicateForFounder(auth.tenant_id, { target, ...input }));
  } catch (e) { linkedinAdsError(res, e); }
}

export const linkedinProposeCampaignDuplicate = (req: Request, res: Response) => proposeDuplicate(req, res, "campaign", req.params.campaignId);
export const linkedinProposeGroupDuplicate = (req: Request, res: Response) => proposeDuplicate(req, res, "campaign_group", req.params.groupId);
