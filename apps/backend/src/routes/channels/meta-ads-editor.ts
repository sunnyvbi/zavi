
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
  createMetaAd,
  createMetaAdSet,
  createMetaCampaign,
  metaAdCreateSchema,
  metaAdSetCreateSchema,
  metaCampaignCreateSchema,
  metaCampaignEditSchema,
  readMetaCampaignEditor,
  saveMetaCampaignEdits,
} from "@/services/connectors/meta-ads/campaign-editor";

const CHANNEL = "meta_ads";
const CampaignId = z.string().trim().regex(/^[0-9]{1,40}$/);

async function gate(req: Request, res: Response, write: boolean) {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return null;
    if (write && (auth as { tenant_overridden?: boolean }).tenant_overridden === true) {
      res.status(403).json({ error: { code: "tenant_override_forbidden", message: "Switch to your own workspace to make changes." } });
      return null;
    }
    if (write && !(await requireTenantRole(auth, ["owner", "admin"], res))) return null;
    const locked = await refuseIfChannelPlanLocked(auth.tenant_id, CHANNEL);
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
  "meta_ads_invalid_target",
  "meta_editor_bad_end",
  "meta_editor_budget_typo",
  "meta_editor_over_cap",
  "meta_editor_invalid",
  "meta_editor_no_pixel",
  "meta_editor_campaign_budget",
  "meta_editor_objective_unsupported",
  "meta_ads_bid_conflict",
  "meta_ads_bid_unavailable",
  "meta_ads_invalid_bid",
  "ad_locations_bad_place",
  "ad_locations_unsupported",
]);

const UNAVAILABLE = "Zavi couldn't reach Meta just now. Nothing new was saved; try again.";

function failStatus(e: ExpectedToolError): number {
  return e.code === "meta_ads_write_disabled" || e.code === "meta_editor_change_open" || e.code === "meta_editor_forbidden" ? 409
    : e.code === "meta_ads_unsupported_currency" ? 409
    : CLIENT_CODES.has(e.code) ? 400
    : e.code.startsWith("meta_ads_") && /token|auth|permission|scope|page/.test(e.code) ? 409
    : 502;
}

function fail(res: Response, e: unknown, tenant_id: string) {
  if (e instanceof EditorPartialSaveError) {
    const cause = e.failure;
    const expected = cause instanceof ExpectedToolError ? cause : null;
    if (!expected) {
      void logEvent({ level: "error", source: "routes/channels/meta-ads-editor", code: "meta_editor.unexpected_error", tenant_id, message: cause instanceof Error ? cause.message : String(cause) });
    }
    const why = expected ? expected.message : "Zavi couldn't reach Meta just now.";
    res.status(expected ? failStatus(expected) : 502).json({
      error: { code: expected?.code ?? "meta_editor_unavailable", message: partialSaveMessage(e, why), partial: true },
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
  void logEvent({ level: "error", source: "routes/channels/meta-ads-editor", code: "meta_editor.unexpected_error", tenant_id, message: e instanceof Error ? e.message : String(e) });
  res.status(502).json({ error: { code: "meta_editor_unavailable", message: UNAVAILABLE } });
}

export async function metaEditorRead(req: Request, res: Response) {
  const auth = await gate(req, res, false);
  if (!auth) return;
  const id = CampaignId.safeParse(req.params.campaignId);
  if (!id.success) {
    res.status(400).json({ error: { code: "bad_request", message: "That is not a Meta campaign id." } });
    return;
  }
  try {
    res.json(await readMetaCampaignEditor(auth.tenant_id, id.data));
  } catch (e) {
    fail(res, e, auth.tenant_id);
  }
}

export async function metaEditorCreate(req: Request, res: Response) {
  const auth = await gate(req, res, true);
  if (!auth) return;
  try {
    const input = metaCampaignCreateSchema.parse(req.body ?? {});
    const change = await createMetaCampaign(asTenantId(auth.tenant_id), auth.user_id, input);
    res.json({ ok: true, changes: [change] });
  } catch (e) {
    fail(res, e, auth.tenant_id);
  }
}

export async function metaEditorSave(req: Request, res: Response) {
  const auth = await gate(req, res, true);
  if (!auth) return;
  const id = CampaignId.safeParse(req.params.campaignId);
  if (!id.success) {
    res.status(400).json({ error: { code: "bad_request", message: "That is not a Meta campaign id." } });
    return;
  }
  try {
    const input = metaCampaignEditSchema.parse(req.body ?? {});
    const changes = await saveMetaCampaignEdits(asTenantId(auth.tenant_id), auth.user_id, id.data, input);
    res.json({ ok: true, changes });
  } catch (e) {
    fail(res, e, auth.tenant_id);
  }
}

async function createIn(req: Request, res: Response, create: (tenant_id: ReturnType<typeof asTenantId>, user_id: string, campaign_id: string) => Promise<unknown>) {
  const auth = await gate(req, res, true);
  if (!auth) return;
  const id = CampaignId.safeParse(req.params.campaignId);
  if (!id.success) {
    res.status(400).json({ error: { code: "bad_request", message: "That is not a Meta campaign id." } });
    return;
  }
  try {
    res.json({ ok: true, changes: [await create(asTenantId(auth.tenant_id), auth.user_id, id.data)] });
  } catch (e) {
    if (e instanceof z.ZodError || (e instanceof ExpectedToolError && !e.code.endsWith("_stage_unknown"))) res.locals.idempotencyRelease = true;
    fail(res, e, auth.tenant_id);
  }
}

export const metaEditorCreateAdSet = (req: Request, res: Response) =>
  createIn(req, res, (tenant_id, user_id, campaign_id) => createMetaAdSet(tenant_id, user_id, campaign_id, metaAdSetCreateSchema.parse(req.body ?? {})));

export const metaEditorCreateAd = (req: Request, res: Response) =>
  createIn(req, res, (tenant_id, user_id, campaign_id) => createMetaAd(tenant_id, user_id, campaign_id, metaAdCreateSchema.parse(req.body ?? {})));

export async function metaEditorLocations(req: Request, res: Response) {
  const auth = await gate(req, res, false);
  if (!auth) return;
  const q = z.object({ q: z.string().trim().min(2).max(100) }).safeParse(req.query);
  if (!q.success) {
    res.json({ locations: [] });
    return;
  }
  try {
    const places = await searchPlaces(auth.tenant_id, "meta_ads", q.data.q);
    res.json({ locations: places.map((p) => ({ id: p.id, name: p.name, type: p.kind })) });
  } catch (e) {
    fail(res, e, auth.tenant_id);
  }
}
