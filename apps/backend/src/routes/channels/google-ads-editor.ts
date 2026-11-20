
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { refuseIfChannelPlanLocked } from "@/services/growth/preview-plan";
import { asTenantId } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";
import { logEvent } from "@/services/logging/logEvent";
import { EditorPartialSaveError, partialSaveMessage } from "@/services/connectors/_editor-save";
import { searchPlaces } from "@/services/ad-locations/service";
import {
  createGoogleAd,
  createGoogleAdGroup,
  createGoogleCampaign,
  createYoutubeCampaign,
  googleAdCreateSchema,
  googleAdGroupCreateSchema,
  googleCampaignCreateSchema,
  googleCampaignEditSchema,
  readGoogleCampaignEditor,
  saveGoogleCampaignEdits,
  youtubeCampaignCreateSchema,
} from "@/services/connectors/google-ads/campaign-editor";

type Channel = "google_ads" | "youtube_ads";
const CampaignId = z.string().trim().regex(/^[0-9]{1,20}$/);

async function gate(req: Request, res: Response, write: boolean, channel: Channel) {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return null;
    if (write && (auth as { tenant_overridden?: boolean }).tenant_overridden === true) {
      res.status(403).json({ error: { code: "tenant_override_forbidden", message: "Switch to your own workspace to make changes." } });
      return null;
    }
    if (write && !(await requireTenantRole(auth, ["owner", "admin"], res))) return null;
    const locked = await refuseIfChannelPlanLocked(auth.tenant_id, channel);
    if (locked) {
      res.status(403).json(locked.body);
      return null;
    }
    return auth;
  } catch {
    res.status(503).json({ error: { code: "authorization_unavailable", message: "Workspace access could not be checked. Try again." } });
    return null;
  }
}

const CLIENT_CODES = new Set([
  "google_ads_invalid_target",
  "google_ads_campaign_name_exists",
  "google_ads_ad_group_name_exists",
  "google_editor_search_only",
  "google_editor_bad_end",
  "google_editor_budget_typo",
  "google_editor_over_cap",
  "google_editor_invalid",
  "google_editor_rejected",
  "google_ads_demand_gen_logo_url_refused",
  "google_ads_demand_gen_logo_fetch_failed",
  "google_ads_demand_gen_logo_invalid",
  "ad_locations_bad_place",
  "ad_locations_unsupported",
]);
const CONFLICT_CODES = new Set([
  "google_ads_write_disabled",
  "google_ads_non_usd_account",
  "google_ads_currency_unverified",
  "google_editor_change_open",
  "google_editor_forbidden",
  "google_editor_drift",
  "google_ads_campaign_not_found",
  "google_ads_ad_group_not_found",
  "google_ads_keyword_not_found",
  "google_ads_video_mutate_unsupported",
]);

function failStatus(e: ExpectedToolError): number {
  return CONFLICT_CODES.has(e.code) ? 409
    : CLIENT_CODES.has(e.code) ? 400
    : /not_connected|token|auth|permission|reconnect/.test(e.code) ? 409
    : 502;
}

function fail(res: Response, e: unknown, tenant_id: string) {
  if (e instanceof EditorPartialSaveError) {
    const cause = e.failure;
    const expected = cause instanceof ExpectedToolError ? cause : null;
    if (!expected) {
      void logEvent({ level: "error", source: "routes/channels/google-ads-editor", code: "google_editor.unexpected_error", tenant_id, message: cause instanceof Error ? cause.message : String(cause) });
    }
    const why = expected ? expected.message : "Zavi couldn't reach Google Ads just now.";
    res.status(expected ? failStatus(expected) : 502).json({
      error: { code: expected?.code ?? "google_editor_unavailable", message: partialSaveMessage(e, why), partial: true },
      changes: [
        ...e.landed,
        ...(expected?.code.endsWith("_stage_unknown") && typeof expected.meta?.decision_id === "string"
          ? [{ label: e.failed_label, decision_id: expected.meta.decision_id, approved: false, code: "stage_unknown" }]
          : []),
      ],
    });
    return;
  }
  if (e instanceof z.ZodError) {
    res.status(400).json({ error: { code: "bad_request", message: e.issues[0]?.message ?? "Check the campaign fields and try again." } });
    return;
  }
  if (e instanceof ExpectedToolError) {
    const unconfirmed = e.code.endsWith("_stage_unknown") && typeof e.meta?.decision_id === "string" && typeof e.meta?.label === "string"
      ? [{ label: e.meta.label, decision_id: e.meta.decision_id, approved: false, code: "stage_unknown" }]
      : null;
    res.status(failStatus(e)).json({ error: { code: e.code, message: e.message }, ...(unconfirmed ? { changes: unconfirmed } : {}) });
    return;
  }
  void logEvent({ level: "error", source: "routes/channels/google-ads-editor", code: "google_editor.unexpected_error", tenant_id, message: e instanceof Error ? e.message : String(e) });
  res.status(502).json({ error: { code: "google_editor_unavailable", message: "Zavi couldn't reach Google Ads just now. Nothing new was saved; try again." } });
}

async function editorRead(channel: Channel, req: Request, res: Response) {
  const auth = await gate(req, res, false, channel);
  if (!auth) return;
  const id = CampaignId.safeParse(req.params.campaignId);
  if (!id.success) {
    res.status(400).json({ error: { code: "bad_request", message: "That is not a Google Ads campaign id." } });
    return;
  }
  try {
    res.json(await readGoogleCampaignEditor(auth.tenant_id, id.data));
  } catch (e) {
    fail(res, e, auth.tenant_id);
  }
}

async function editorCreate(channel: Channel, req: Request, res: Response) {
  const auth = await gate(req, res, true, channel);
  if (!auth) return;
  try {
    const tid = asTenantId(auth.tenant_id);
    const change =
      channel === "youtube_ads"
        ? await createYoutubeCampaign(tid, auth.user_id, youtubeCampaignCreateSchema.parse(req.body ?? {}))
        : await createGoogleCampaign(tid, auth.user_id, googleCampaignCreateSchema.parse(req.body ?? {}));
    res.json({ ok: true, changes: [change] });
  } catch (e) {
    fail(res, e, auth.tenant_id);
  }
}

async function editorSave(channel: Channel, req: Request, res: Response) {
  const auth = await gate(req, res, true, channel);
  if (!auth) return;
  const id = CampaignId.safeParse(req.params.campaignId);
  if (!id.success) {
    res.status(400).json({ error: { code: "bad_request", message: "That is not a Google Ads campaign id." } });
    return;
  }
  try {
    const input = googleCampaignEditSchema.parse(req.body ?? {});
    const changes = await saveGoogleCampaignEdits(asTenantId(auth.tenant_id), auth.user_id, id.data, input);
    res.json({ ok: true, changes });
  } catch (e) {
    fail(res, e, auth.tenant_id);
  }
}

async function createIn(req: Request, res: Response, create: (tenant_id: ReturnType<typeof asTenantId>, user_id: string, campaign_id: string) => Promise<unknown>) {
  const auth = await gate(req, res, true, "google_ads");
  if (!auth) return;
  const id = CampaignId.safeParse(req.params.campaignId);
  if (!id.success) {
    res.status(400).json({ error: { code: "bad_request", message: "That is not a Google Ads campaign id." } });
    return;
  }
  try {
    res.json({ ok: true, changes: [await create(asTenantId(auth.tenant_id), auth.user_id, id.data)] });
  } catch (e) {
    if (e instanceof z.ZodError || (e instanceof ExpectedToolError && !e.code.endsWith("_stage_unknown"))) res.locals.idempotencyRelease = true;
    fail(res, e, auth.tenant_id);
  }
}

export const googleEditorCreateAdGroup = (req: Request, res: Response) =>
  createIn(req, res, (tenant_id, user_id, campaign_id) => createGoogleAdGroup(tenant_id, user_id, campaign_id, googleAdGroupCreateSchema.parse(req.body ?? {})));

export const googleEditorCreateAd = (req: Request, res: Response) =>
  createIn(req, res, (tenant_id, user_id, campaign_id) => createGoogleAd(tenant_id, user_id, campaign_id, googleAdCreateSchema.parse(req.body ?? {})));

async function editorLocations(channel: Channel, req: Request, res: Response) {
  const auth = await gate(req, res, false, channel);
  if (!auth) return;
  const q = z.object({ q: z.string().trim().min(2).max(100) }).safeParse(req.query);
  if (!q.success) {
    res.json({ locations: [] });
    return;
  }
  try {
    const places = await searchPlaces(auth.tenant_id, channel, q.data.q);
    res.json({ locations: places.map((p) => ({ id: p.id, name: p.name, type: p.kind })) });
  } catch (e) {
    fail(res, e, auth.tenant_id);
  }
}

export const googleEditorRead = (req: Request, res: Response) => editorRead("google_ads", req, res);
export const googleEditorCreate = (req: Request, res: Response) => editorCreate("google_ads", req, res);
export const googleEditorSave = (req: Request, res: Response) => editorSave("google_ads", req, res);
export const googleEditorLocations = (req: Request, res: Response) => editorLocations("google_ads", req, res);
export const youtubeEditorRead = (req: Request, res: Response) => editorRead("youtube_ads", req, res);
export const youtubeEditorCreate = (req: Request, res: Response) => editorCreate("youtube_ads", req, res);
export const youtubeEditorSave = (req: Request, res: Response) => editorSave("youtube_ads", req, res);
export const youtubeEditorLocations = (req: Request, res: Response) => editorLocations("youtube_ads", req, res);
