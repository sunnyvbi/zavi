
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth, type AuthedRequest } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { checkAgentTier } from "@/services/agents/entitlement";
import { emailSendHttpRefusal } from "@/services/agents/email-send-tier";
import * as api from "@/services/email-plan/api";
import { PLAN_ROUTES } from "@/services/email-plan/plan";
import { withCardStatus } from "@/services/email-plan/card-status";
import type { CardDeps } from "@/services/email-cards/cards";

const Id = z.object({ id: z.string().uuid() });
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const TIME = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const PlanBody = z
  .object({
    route: z.enum(PLAN_ROUTES),
    list_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    date: DATE,
    time: TIME,
    angle: z.string().trim().min(3).max(120),
    request_id: z.string().min(8).max(200),
  })
  .strict();
const ZONE = z.string().min(1).max(64).regex(/^[A-Za-z0-9_+\-/]+$/);
const MoveBody = z.object({ date: DATE, time: TIME, schedule_gen: z.number().int().min(1), timezone: ZONE.optional() }).strict();
const AngleBody = z.object({ angle: z.string().trim().min(3).max(120), content_version: z.number().int().min(1) }).strict();
const ScheduleBody = z
  .object({
    variant: z.number().int().min(1).max(3),
    schedule_gen: z.number().int().min(1),
    content_version: z.number().int().min(1),
    request_id: z.string().min(8).max(200),
  })
  .strict();
const HoldParams = z.object({ rail: z.enum(["channel_actions", "decisions"]), card_id: z.string().uuid() });
const NotSentBody = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

const STATUS: Record<string, number> = {
  bad_request: 400,
  bad_time: 400,
  nonexistent_time: 400,
  not_authorized: 403,
  bad_timezone: 400,
  not_found: 404,
  list_not_found: 404,
  still_sending: 409,
  count_required: 409,
  tool_key_rejected: 409,
  plan_unreadable: 409,
  email_tool_read_failed: 502,
};

type Out = { ok: boolean; code?: unknown; message?: unknown };

function send(res: Response, out: Out): void {
  if (out.ok) {
    res.json(out);
    return;
  }
  const code = typeof out.code === "string" ? out.code : "refused";
  res.status(STATUS[code] ?? 409).json({ error: { code, message: typeof out.message === "string" ? out.message : "That could not be done." } });
}

function internal(res: Response, where: string): void {
  console.error(`[email-plan] ${where} failed`);
  res.status(500).json({ error: { code: "internal_error", message: "That did not work. Try again." } });
}

async function changer(req: Request, res: Response): Promise<AuthedRequest | null> {
  const auth = await requireAuth(req, res);
  if (!auth) return null;
  if (auth.tenant_overridden === true) {
    res.status(403).json({ error: { code: "tenant_override_forbidden", message: "Not available for an overridden workspace." } });
    return null;
  }
  if (!(await requireTenantRole(auth, ["owner", "admin"], res))) return null;
  return auth;
}

export function emailPlanHandlers(deps: Partial<api.ApiDeps> = {}, tierCheck: typeof checkAgentTier = checkAgentTier, cardDeps: Partial<CardDeps> = {}) {
  const cardReads: Partial<CardDeps> = deps.rpc ? { rpc: deps.rpc, ...cardDeps } : cardDeps;
  const planRefused = async (auth: AuthedRequest, res: Response): Promise<boolean> => {
    const tier = await emailSendHttpRefusal(auth.tenant_id, tierCheck);
    if (tier) res.status(tier.status).json(tier.body);
    return tier !== null;
  };
  const withId = (
    where: string,
    schema: z.ZodTypeAny | null,
    run: (auth: AuthedRequest, id: string, body: unknown) => Promise<Out>,
    needsPlan = false,
  ) =>
    async function handler(req: Request, res: Response): Promise<void> {
      const auth = await changer(req, res);
      if (!auth) return;
      const p = Id.safeParse(req.params);
      if (!p.success) return send(res, { ok: false, code: "not_found", message: "That planned email was not found." });
      const b = schema ? schema.safeParse(req.body ?? {}) : { success: true as const, data: null };
      if (!b.success) return send(res, { ok: false, code: "bad_request", message: "That request was not complete." });
      if (needsPlan && (await planRefused(auth, res))) return;
      try {
        send(res, await run(auth, p.data.id, b.data));
      } catch {
        internal(res, where);
      }
    };

  return {
    async list(req: Request, res: Response): Promise<void> {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      try {
        res.setHeader("Cache-Control", "no-store");
        send(res, await withCardStatus(auth.tenant_id, auth.user_id, await api.readPlan(auth.tenant_id, auth.user_id, deps), cardReads));
      } catch {
        internal(res, "list");
      }
    },
    async plan(req: Request, res: Response): Promise<void> {
      const auth = await changer(req, res);
      if (!auth) return;
      const b = PlanBody.safeParse(req.body ?? {});
      if (!b.success) return send(res, { ok: false, code: "bad_request", message: "Pick a list, a day, a time and an angle." });
      if (await planRefused(auth, res)) return;
      try {
        send(res, await api.planByFounder(auth.tenant_id, auth.user_id, b.data, deps));
      } catch {
        internal(res, "plan");
      }
    },
    move: withId("move", MoveBody, (a, id, b) => api.movePlanned(a.tenant_id, a.user_id, id, b as z.infer<typeof MoveBody>, deps)),
    angle: withId("angle", AngleBody, (a, id, b) => api.changePlannedAngle(a.tenant_id, a.user_id, id, b as z.infer<typeof AngleBody>, deps)),
    skip: withId("skip", null, (a, id) => api.skipPlanned(a.tenant_id, a.user_id, id, deps)),
    draftNow: withId("draft-now", null, (a, id) => api.draftPlannedNow(a.tenant_id, a.user_id, id, deps), true),
    schedule: withId("schedule", ScheduleBody, (a, id, b) => api.schedulePlanned(a.tenant_id, a.user_id, id, b as z.infer<typeof ScheduleBody>, deps), true),
    withdraw: withId("withdraw", null, (a, id) => api.withdrawPlanned(a.tenant_id, a.user_id, id, deps)),
    async notSent(req: Request, res: Response): Promise<void> {
      const auth = await changer(req, res);
      if (!auth) return;
      const p = HoldParams.safeParse(req.params);
      if (!p.success) return send(res, { ok: false, code: "not_found", message: "That email was not found." });
      const b = NotSentBody.safeParse(req.body ?? {});
      if (!b.success) return send(res, { ok: false, code: "bad_request", message: "Say what you checked in your email tool." });
      try {
        send(res, await api.confirmNotSent(auth.tenant_id, auth.user_id, p.data.rail, p.data.card_id, b.data.reason, deps));
      } catch {
        internal(res, "not-sent");
      }
    },
  };
}

const live = emailPlanHandlers();
export const getEmailPlanHandler = live.list;
export const postEmailPlanHandler = live.plan;
export const postEmailPlanMoveHandler = live.move;
export const postEmailPlanAngleHandler = live.angle;
export const postEmailPlanSkipHandler = live.skip;
export const postEmailPlanDraftNowHandler = live.draftNow;
export const postEmailPlanScheduleHandler = live.schedule;
export const postEmailPlanWithdrawHandler = live.withdraw;
export const postEmailPlanNotSentHandler = live.notSent;
