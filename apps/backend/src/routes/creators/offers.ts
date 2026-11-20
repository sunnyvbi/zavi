
import type { Request, Response } from "express";
import { z } from "zod";
import { verifyBearer } from "@/services/auth/jwt";
import { requireAuth } from "@/services/auth/middleware";
import { refuseViewerWrite } from "@/services/auth/viewer";
import { ExpectedToolError } from "@/services/tools/types";
import { logEvent } from "@/services/logging/logEvent";
import {
  AGENT_HIRE_AWAITING_APPROVAL_CODE,
  agentHireAwaitingApproval,
  refuseAgentHireCheckout,
  startCreatorCheckout,
} from "@/services/creators/booking";
import { findOrderByOffer } from "@/services/creators/booking-db";
import { resumeOrderCheckout } from "@/services/creators/checkout-resume";
import { offerReturnUrls } from "@/services/creators/offer-money-port";
import {
  authorizeCreatorThreadAccess,
  isBookableCreator,
} from "@/services/creators/thread";
import {
  acceptCreatorOffer,
  authorizeOfferAccess,
  closeCreatorOffer,
  createCreatorOffer,
  getOfferView,
  offerForSide,
  HIRE_REFUSED_MESSAGE,
  type OfferError,
} from "@/services/creators/offers";

const ThreadParam = z.object({ thread_id: z.string().uuid() });
const OfferParam = z.object({ offer_id: z.string().uuid() });
const CreatorParam = z.object({ human_member_id: z.string().uuid() });

const OfferBody = z.object({
  kind: z.enum(["ugc_video"]),
  terms: z.record(z.string(), z.unknown()),
  price_cents: z.number().int().positive().max(10_000_000),
  delivery_days: z.number().int().min(1).max(90),
  note: z.string().trim().min(1).max(2000).optional(),
  product_needed: z.boolean().optional(),
});

const ERROR_STATUS: Record<OfferError, number> = {
  offer_not_found: 404,
  not_authorized: 403,
  cannot_accept_own_offer: 403,
  offer_expired: 409,
  offer_not_open: 409,
  hire_refused: 409,
};

const ERROR_MESSAGE: Record<OfferError, string> = {
  offer_not_found: "Offer not found.",
  not_authorized: "You cannot do that on this offer.",
  cannot_accept_own_offer: "The side that sent an offer cannot accept it.",
  offer_expired: "This offer expired (72 hours passed, or its due date did). Ask for a new one.",
  offer_not_open: "This offer is no longer open.",
  hire_refused: HIRE_REFUSED_MESSAGE,
};

function failOffer(res: Response, code: OfferError): void {
  res.status(ERROR_STATUS[code]).json({ error: { code, message: ERROR_MESSAGE[code] } });
}

async function failUnexpected(
  res: Response,
  where: string,
  tenant_id: string | null,
  e: unknown,
): Promise<void> {
  if (e instanceof ExpectedToolError) {
    res.status(e.code === AGENT_HIRE_AWAITING_APPROVAL_CODE ? 409 : 400).json({ error: { code: e.code, message: e.message } });
    return;
  }
  await logEvent({
    level: "error",
    source: "creator.offers",
    code: "creator_offer_route_threw",
    tenant_id,
    error: e,
    meta: { op: where },
  }).catch(() => {});
  res.status(500).json({
    error: {
      code: "creator_offer_failed",
      message: "Zavi could not finish that. Nothing was charged. Try again in a moment.",
    },
  });
}

export async function postThreadOffer(req: Request, res: Response): Promise<void> {
  const verified = await verifyBearer(req);
  if (!verified) {
    res.status(401).json({ error: { code: "unauthorized", message: "Sign in required." } });
    return;
  }
  const params = ThreadParam.safeParse(req.params);
  if (!params.success) {
    res
      .status(400)
      .json({ error: { code: "invalid_thread_id", message: "thread_id must be a UUID" } });
    return;
  }
  const body = OfferBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: { code: "bad_request", message: "Offer details are incomplete." } });
    return;
  }

  const auth = await authorizeCreatorThreadAccess({
    auth_user_id: verified.user_id,
    thread_id: params.data.thread_id,
  });
  if (!auth.ok) {
    res.status(404).json({ error: { code: "not_found", message: "Thread not found." } });
    return;
  }
  if (refuseViewerWrite(req, res, auth.access.tenant_role)) return;

  const offer = await createCreatorOffer({
    tenant_id: auth.access.tenant_id,
    human_member_id: auth.access.human_member_id,
    proposed_by: auth.access.sender_kind,
    proposed_by_user_id: verified.user_id,
    thread_id: auth.access.thread_id,
    kind: body.data.kind,
    terms: body.data.terms,
    price_cents: body.data.price_cents,
    delivery_days: body.data.delivery_days,
    note: body.data.note ?? null,
    product_needed: body.data.product_needed === true,
  });
  res.json({ ok: true, offer: offerForSide(offer, auth.access.sender_kind) });
}

export async function postStorefrontOffer(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const params = CreatorParam.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({
      error: { code: "invalid_creator_id", message: "human_member_id must be a UUID" },
    });
    return;
  }
  const body = OfferBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: { code: "bad_request", message: "Offer details are incomplete." } });
    return;
  }
  if (!(await isBookableCreator(params.data.human_member_id))) {
    res.status(404).json({ error: { code: "not_found", message: "Creator not found." } });
    return;
  }

  const offer = await createCreatorOffer({
    tenant_id: auth.tenant_id,
    human_member_id: params.data.human_member_id,
    proposed_by: "tenant",
    proposed_by_user_id: auth.user_id,
    kind: body.data.kind,
    terms: body.data.terms,
    price_cents: body.data.price_cents,
    delivery_days: body.data.delivery_days,
    note: body.data.note ?? null,
    product_needed: body.data.product_needed === true,
  });
  res.json({ ok: true, offer });
}

async function resolveOffer(req: Request, res: Response) {
  const verified = await verifyBearer(req);
  if (!verified) {
    res.status(401).json({ error: { code: "unauthorized", message: "Sign in required." } });
    return null;
  }
  const params = OfferParam.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: { code: "invalid_offer_id", message: "offer_id must be a UUID" } });
    return null;
  }
  const auth = await authorizeOfferAccess({
    auth_user_id: verified.user_id,
    offer_id: params.data.offer_id,
  });
  if (!auth.ok) {
    res.status(404).json({ error: { code: "not_found", message: "Offer not found." } });
    return null;
  }
  if (refuseViewerWrite(req, res, auth.access.tenant_role)) return null;
  return { access: auth.access, offer_id: params.data.offer_id };
}

export async function getCreatorOffer(req: Request, res: Response): Promise<void> {
  const ctx = await resolveOffer(req, res);
  if (!ctx) return;
  const offer = await getOfferView({
    tenant_id: ctx.access.tenant_id,
    offer_id: ctx.offer_id,
  });
  if (!offer) {
    res.status(404).json({ error: { code: "not_found", message: "Offer not found." } });
    return;
  }
  res.json({ ok: true, sender_kind: ctx.access.sender_kind, offer: offerForSide(offer, ctx.access.sender_kind) });
}

export async function acceptCreatorOfferRoute(req: Request, res: Response): Promise<void> {
  const ctx = await resolveOffer(req, res);
  if (!ctx) return;
  try {
    const result = await acceptCreatorOffer({
      access: {
        tenant_id: ctx.access.tenant_id,
        sender_kind: ctx.access.sender_kind,
        human_member_id: ctx.access.human_member_id,
      },
      offer_id: ctx.offer_id,
    });
    if (!result.ok) {
      failOffer(res, result.code);
      return;
    }
    const creator = ctx.access.sender_kind === "creator";
    res.json({
      ok: true,
      offer: offerForSide(result.offer, ctx.access.sender_kind),
      order: creator ? { order_id: result.order.order_id, status: result.order.status } : result.order,
    });
  } catch (e) {
    await failUnexpected(res, "accept", ctx.access.tenant_id, e);
  }
}

export async function declineCreatorOfferRoute(req: Request, res: Response): Promise<void> {
  await closeRoute(req, res, "decline");
}

export async function withdrawCreatorOfferRoute(req: Request, res: Response): Promise<void> {
  await closeRoute(req, res, "withdraw");
}

async function closeRoute(req: Request, res: Response, action: "decline" | "withdraw") {
  const ctx = await resolveOffer(req, res);
  if (!ctx) return;
  const result = await closeCreatorOffer({
    access: { tenant_id: ctx.access.tenant_id, sender_kind: ctx.access.sender_kind },
    offer_id: ctx.offer_id,
    action,
  });
  if (!result.ok) {
    failOffer(res, result.code);
    return;
  }
  res.json({ ok: true, offer: offerForSide(result.offer, ctx.access.sender_kind) });
}

export async function postCreatorOfferCheckout(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const params = OfferParam.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: { code: "invalid_offer_id", message: "offer_id must be a UUID" } });
    return;
  }
  try {
    const offer = await getOfferView({ tenant_id: auth.tenant_id, offer_id: params.data.offer_id });
    if (offer?.agent_run_id) throw agentHireAwaitingApproval();
    if (offer?.expired) {
      failOffer(res, "offer_expired");
      return;
    }
    const existing = await findOrderByOffer(auth.tenant_id, params.data.offer_id);
    if (existing) {
      await refuseAgentHireCheckout(auth.tenant_id, existing.id);
      const resumed = await resumeOrderCheckout({ tenant_id: auth.tenant_id, order_id: existing.id });
      res.json({ ok: true, ...resumed });
      return;
    }
    const urls = offerReturnUrls();
    const started = await startCreatorCheckout({
      tenant_id: auth.tenant_id,
      user_id: auth.user_id ?? null,
      target: { source: "offer", offer_id: params.data.offer_id },
      large_amount_confirmed: true,
      success_url: urls.success_url,
      cancel_url: urls.cancel_url,
      offer_already_claimed: true,
    });
    res.json({ ok: true, order_id: started.order_id, checkout_url: started.checkout_url });
  } catch (e) {
    await failUnexpected(res, "checkout", auth.tenant_id, e);
  }
}
