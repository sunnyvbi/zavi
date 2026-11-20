import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { checkAgentTier } from "@/services/agents/entitlement";
import { isChannelLocked } from "@/services/channels/lock";
import { ExpectedToolError } from "@/services/tools/types";
import { logEvent } from "@/services/logging/logEvent";
import { campaignChange, campaignCreate, createCampaign, readCampaignEntities, readCampaignSafety, updateAdStatus, updateCampaign } from "@/services/connectors/chatgpt-ads/workspace";

export async function adsAuth(req: Request, res: Response, write = false, allowUnavailable = false) {
  try {
  const auth = await requireAuth(req, res);
  if (!auth) return null;
  if (write && (auth as { tenant_overridden?: boolean }).tenant_overridden) {
    res.status(403).json({ error: { code: "tenant_override_forbidden", message: "Switch to your own workspace to make changes." } }); return null;
  }
  if (write && !(await requireTenantRole(auth, ["owner", "admin"], res))) return null;
  if (allowUnavailable) return auth;
  const tier = await checkAgentTier(auth.tenant_id, "chatgpt_ads");
  if (!tier.allowed || await isChannelLocked("chatgpt_ads")) {
    res.status(403).json({ error: { code: "channel_unavailable", message: "ChatGPT Ads is not available for this workspace." } }); return null;
  }
  return auth;
  } catch {
    res.status(503).json({ error: { code: "authorization_unavailable", message: "Workspace access could not be checked. Try again." } });
    return null;
  }
}

export function adsError(res: Response, error: unknown) {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: { code: "bad_request", message: "Check the campaign fields and try again." } }); return;
  }
  const code = error instanceof ExpectedToolError ? error.code : "chatgpt_ads_unavailable";
  if (!(error instanceof ExpectedToolError)) void logEvent({ level: "error", source: "chatgpt-ads", code: "chatgpt_ads.unexpected_error", message: error instanceof Error ? error.message : String(error) });
  const status = code === "chatgpt_ads_not_found" ? 404
    : code === "chatgpt_ads_conflict" || code === "ads_balance_insufficient" ? 409
    : code === "chatgpt_ads_card_declined" || code === "insufficient_credits" ? 402
    : code.startsWith("chatgpt_ads_card_") ? 400
    : code === "image_not_owned" || code === "image_refused" ? 422
    : code === "image_daily_limit" ? 429
    : code === "image_service_unavailable" || code === "image_unavailable" ? 503
    : 502;
  res.status(status).json({ error: { code, message: error instanceof ExpectedToolError ? error.message : "The request could not be completed. Refresh before trying again." } });
}

export async function chatgptEntities(req: Request, res: Response) {
  const auth = await adsAuth(req, res); if (!auth) return;
  try {
    const { level, days } = z.object({ level: z.enum(["ad_group", "ad"]), days: z.coerce.number().int().refine(n => [7, 14, 30].includes(n)).default(30) }).parse(req.query);
    res.json({ rows: await readCampaignEntities(auth.tenant_id, req.params.campaignId, level, days) });
  } catch (e) { adsError(res, e); }
}

function pauseOnly(body: unknown, keys: readonly string[]): boolean {
  return !!body && typeof body === "object" && !Array.isArray(body)
    && (body as Record<string, unknown>).status === "paused"
    && Object.keys(body).every(k => keys.includes(k));
}
export async function chatgptSafety(req: Request, res: Response) {
  const auth = await adsAuth(req, res, false, true); if (!auth) return;
  try { res.json(await readCampaignSafety(auth.tenant_id)); } catch (e) { adsError(res, e); }
}

export async function chatgptUpdateCampaign(req: Request, res: Response) {
  const auth = await adsAuth(req, res, true, pauseOnly(req.body, ["status", "expected_updated_at"])); if (!auth) return;
  try {
    const body = campaignChange.parse(req.body);
    const campaign = await updateCampaign(auth.tenant_id, req.params.campaignId, body);
    await logEvent({ level: "info", source: "chatgpt-ads", code: "chatgpt_ads.campaign_updated", tenant_id: auth.tenant_id, message: "Workspace administrator updated a campaign." });
    res.json({ campaign });
  } catch (e) { adsError(res, e); }
}

const createRequestId = (req: Request) => z.string().uuid().parse(req.headers["idempotency-key"]);

export async function chatgptCreateCampaign(req: Request, res: Response) {
  const auth = await adsAuth(req, res, true); if (!auth) return;
  try {
    const campaign = await createCampaign(auth.tenant_id, campaignCreate.parse(req.body), createRequestId(req));
    res.status(201).json({ campaign });
  } catch (e) { adsError(res, e); }
}

export async function chatgptUpdateAd(req: Request, res: Response) {
  const auth = await adsAuth(req, res, true, pauseOnly(req.body, ["status", "ad_group_id"])); if (!auth) return;
  try {
    const { status, ad_group_id, expected_campaign_updated_at } = z.object({ status: z.enum(["active", "paused"]), ad_group_id: z.string().min(1).max(200), expected_campaign_updated_at: z.number().int().optional() }).strict().parse(req.body);
    res.json(await updateAdStatus(auth.tenant_id, req.params.campaignId, ad_group_id, req.params.adId, status, expected_campaign_updated_at));
  } catch (e) { adsError(res, e); }
}

export async function chatgptCreateGroup(req: Request, res: Response) {
  const auth = await adsAuth(req, res, true); if (!auth) return;
  try {
    const { groupCreate, createAdGroup } = await import("@/services/connectors/chatgpt-ads/workspace");
    res.status(201).json(await createAdGroup(auth.tenant_id, req.params.campaignId, groupCreate.parse(req.body), createRequestId(req)));
  } catch (e) { adsError(res, e); }
}
export async function chatgptSaveCreative(req: Request, res: Response) {
  const auth = await adsAuth(req, res, true); if (!auth) return;
  try {
    const { adCreative, saveAdCreative } = await import("@/services/connectors/chatgpt-ads/workspace");
    res.json(await saveAdCreative(auth.tenant_id, req.params.campaignId, adCreative.parse(req.body), req.params.adId, req.params.adId ? undefined : createRequestId(req)));
  } catch (e) { adsError(res, e); }
}
export async function chatgptUpdateGroup(req: Request, res: Response) {
  const auth = await adsAuth(req, res, true, pauseOnly(req.body, ["status"])); if (!auth) return;
  try {
    const { status, expected_campaign_updated_at } = z.object({ status: z.enum(["active", "paused"]), expected_campaign_updated_at: z.number().int().optional() }).strict().parse(req.body);
    const { updateGroupStatus } = await import("@/services/connectors/chatgpt-ads/workspace");
    res.json(await updateGroupStatus(auth.tenant_id, req.params.campaignId, req.params.groupId, status, expected_campaign_updated_at));
  } catch (e) { adsError(res, e); }
}

export async function chatgptResources(req: Request, res: Response) {
  const auth = await adsAuth(req, res); if (!auth) return;
  try { const { resourceOptions } = await import("@/services/connectors/chatgpt-ads/resources"); res.json(await resourceOptions(auth.tenant_id)); } catch (e) { adsError(res, e); }
}
export async function chatgptCampaignResources(req: Request,res:Response) {
  const auth=await adsAuth(req,res);if(!auth)return;
  try {
    const {ownedCampaign}=await import("@/services/connectors/chatgpt-ads/workspace");
    const {resourceOptions}=await import("@/services/connectors/chatgpt-ads/resources");
    const {key,binding}=await ownedCampaign(auth.tenant_id,req.params.campaignId);
    res.json(await resourceOptions(auth.tenant_id,{key,accountId:binding.account_id}));
  }catch(e){adsError(res,e);}
}
export async function chatgptReadCampaign(req: Request, res: Response) {
  const auth = await adsAuth(req, res); if (!auth) return;
  try { const { ownedCampaign, publicCampaign } = await import("@/services/connectors/chatgpt-ads/workspace"); const c=await ownedCampaign(auth.tenant_id,req.params.campaignId); res.json({campaign:publicCampaign(c.campaign),campaign_name_prefix:c.prefix,currency:c.providerCurrency}); } catch(e){adsError(res,e);}
}
export async function chatgptEditGroup(req: Request, res: Response) {
  const auth = await adsAuth(req, res, true); if (!auth) return;
  try { const { editAdGroup, groupCreate } = await import("@/services/connectors/chatgpt-ads/workspace"); res.json(await editAdGroup(auth.tenant_id, req.params.campaignId, req.params.groupId, groupCreate.parse(req.body))); } catch (e) { adsError(res, e); }
}

export async function chatgptReport(req: Request, res: Response) {
  const auth = await adsAuth(req, res); if (!auth) return;
  try { const query = z.object({ days: z.coerce.number().int().refine(n => [7,14,30].includes(n)).default(30), breakdown: z.enum(["daily", "country"]) }).parse(req.query); const { campaignReport } = await import("@/services/connectors/chatgpt-ads/workspace"); res.json(await campaignReport(auth.tenant_id, req.params.campaignId, query.days, query.breakdown)); } catch (e) { adsError(res, e); }
}
export async function chatgptLocations(req: Request, res: Response) {
  const auth = await adsAuth(req, res); if (!auth) return;
  try {
    const { q } = z.object({ q: z.string().trim().min(2).max(100) }).parse(req.query);
    const { chatgptAdsGet } = await import("@/services/connectors/chatgpt-ads/http");
    const { previewChatgptAccount } = await import("@/services/ads-wallet/chatgpt-account-preview");
    const {key}=await previewChatgptAccount(auth.tenant_id);
    const r = await chatgptAdsGet<{ results: unknown[] }>(key, "/geo_lookup/search", { q, limit: 20 });
    if (!Array.isArray(r.results)) throw new Error("Unreadable geographic results");
    const location = z.object({ id: z.string().min(1), canonical_name: z.string().min(1) });
    const seen = new Set<string>();
    const locations = r.results.flatMap(value => {
      const parsed = location.safeParse(value);
      if (!parsed.success || seen.has(parsed.data.id)) return [];
      seen.add(parsed.data.id);
      const source = value as Record<string, unknown>;
      const metadata = Object.fromEntries(["type", "country_code", "region_code", "parent_country"].flatMap(field =>
        typeof source[field] === "string" && source[field].trim() ? [[field, source[field].trim()]] : []));
      return [{ id: parsed.data.id, name: parsed.data.canonical_name, ...metadata }];
    });
    res.json({ locations });
  } catch (e) { adsError(res, e); }
}

export async function chatgptReviewAction(req: Request, res: Response) {
  const auth = await adsAuth(req, res, true); if (!auth) return;
  try {
    const { reviewCampaignAction } = await import("@/services/connectors/chatgpt-ads/action-execution");
    res.json(await reviewCampaignAction(auth.tenant_id, req.params.actionId));
  } catch (e) { adsError(res, e); }
}
export async function chatgptPrepareAction(req: Request, res: Response) {
  const auth = await adsAuth(req, res, true); if (!auth) return;
  try {
    const { prepareCampaignAction } = await import("@/services/connectors/chatgpt-ads/action-execution");
    res.json(await prepareCampaignAction(auth.tenant_id, req.params.actionId, auth.user_id, req.body));
  } catch (e) { adsError(res, e); }
}

export async function chatgptCreateAdImage(req: Request, res: Response) {
  const auth = await adsAuth(req, res, true); if (!auth) return;
  try {
    const { createAdImage } = await import("@/services/connectors/chatgpt-ads/ad-image");
    res.json(await createAdImage(auth.tenant_id, req.params.actionId, req.body));
  } catch (e) { adsError(res, e); }
}

export async function chatgptLaunchSummary(req: Request, res: Response) {
  const auth = await adsAuth(req, res, true); if (!auth) return;
  try {
    const { readLaunchSummary } = await import("@/services/connectors/chatgpt-ads/launch");
    res.json(await readLaunchSummary(auth.tenant_id, req.params.campaignId));
  } catch (e) { adsError(res, e); }
}
export async function chatgptLaunch(req: Request, res: Response) {
  const auth = await adsAuth(req, res, true); if (!auth) return;
  try {
    const { launchCampaign } = await import("@/services/connectors/chatgpt-ads/launch");
    const result = await launchCampaign(auth.tenant_id, req.params.campaignId, req.body);
    res.status(result.ok ? 200 : 409).json(result);
  } catch (e) { adsError(res, e); }
}
