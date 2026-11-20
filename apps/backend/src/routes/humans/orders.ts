
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { businessJobReturnPaths } from "@/services/creators/hub-links";
import { resumeOrderCheckout } from "@/services/creators/checkout-resume";
import { ExpectedToolError } from "@/services/tools/types";
import { logEvent } from "@/services/logging/logEvent";
import {
  BOOKING_BRIEF_BODY_MAX,
  BOOKING_BRIEF_TITLE_MAX,
  AGENT_HIRE_AWAITING_APPROVAL_CODE,
  bookingBriefSnapshot,
  quoteCreatorBooking,
  refuseAgentHireCheckout,
  startCreatorCheckout,
  type BookingTarget,
} from "@/services/creators/booking";
import { fulfilCreatorCheckout } from "@/services/creators/checkout-fulfil";
import {
  BUSINESS_ACTION_TRIGGER,
  runBusinessAction,
  type BusinessAction,
} from "@/services/creators/business-actions";
import { getBusinessJob, listBusinessJobs } from "@/services/creators/jobs-views";

const Uuid = z
  .string()
  .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/);

const TargetSchema = z
  .union([
    z.object({ package_id: Uuid }),
    z.object({ offer_id: Uuid }),
    z.object({ application_id: Uuid }),
  ])
  .transform((v): BookingTarget => {
    if ("package_id" in v) return { source: "booking", package_id: v.package_id };
    if ("offer_id" in v) return { source: "offer", offer_id: v.offer_id };
    return { source: "applicant", application_id: v.application_id };
  });

const BriefContext = {
  brief_id: Uuid.optional(),
  product_needed: z.boolean().optional(),
};

const QuoteSchema = z.object({
  target: TargetSchema,
  due_at: z.string().min(1).nullish().transform((v) => v ?? undefined),
  ...BriefContext,
});

const CreateSchema = z.object({
  target: TargetSchema,
  due_at: z.string().min(1).nullish().transform((v) => v ?? undefined),
  large_amount_confirmed: z.boolean().optional(),
  return_path: z.string().max(300).optional(),
  brief_title: z.string().max(BOOKING_BRIEF_TITLE_MAX).optional(),
  brief: z.string().max(BOOKING_BRIEF_BODY_MAX).optional(),
  ...BriefContext,
});

const ActionSchema = z.object({
  action: z.enum(Object.keys(BUSINESS_ACTION_TRIGGER) as [BusinessAction, ...BusinessAction[]]),
  note: z.string().max(4000).optional(),
});

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

const STATUS_BY_CODE: Record<string, number> = {
  package_not_found: 404,
  offer_not_found: 404,
  application_not_found: 404,
  creator_order_not_found: 404,
  creator_not_found: 404,
  creator_not_available: 409,
  package_inactive: 409,
  offer_not_open: 409,
  offer_expired: 409,
  already_hired: 409,
  already_booked: 409,
  application_closed: 409,
  applicant_has_no_price: 409,
  creator_payout_country_unsupported: 409,
  creator_order_not_awaiting_checkout: 409,
  large_amount_confirm_required: 409,
  [AGENT_HIRE_AWAITING_APPROVAL_CODE]: 409,
  invalid_due_date: 400,
  invalid_price: 400,
  checkout_amount_mismatch: 502,
  creator_hold_not_held: 409,
  creator_hold_amount_mismatch: 502,
  order_fees_inconsistent: 500,
  livemode_mismatch: 500,
  stripe_platform_not_configured: 503,
  stripe_provisioning_disabled: 503,
  creator_payments_disabled: 503,
};

async function handleServiceError(
  res: Response,
  tenant_id: string,
  where: string,
  e: unknown,
): Promise<void> {
  if (e instanceof ExpectedToolError) {
    const status = STATUS_BY_CODE[e.code] ?? 400;
    if (status >= 500) {
      await logEvent({
        level: "error",
        source: "creator.orders",
        code: "creator_order_route_failed",
        tenant_id,
        meta: { op: where, reject_reason: e.code },
      }).catch(() => {});
    }
    fail(res, status, e.code, e.message);
    return;
  }
  await logEvent({
    level: "error",
    source: "creator.orders",
    code: "creator_order_route_threw",
    tenant_id,
    message: (e as Error)?.message?.slice(0, 300),
    meta: { op: where },
  }).catch(() => {});
  fail(
    res,
    500,
    "creator_order_failed",
    "Zavi could not finish that. Nothing was charged. Try again in a moment.",
  );
}

function returnUrls(return_path?: string): { success_url: string; cancel_url: string } {
  const origin = (process.env.WEB_ORIGIN || "https://www.zaviagent.com")
    .split(",")[0]
    .trim()
    .replace(/\/+$/, "");
  if (return_path === "ugc") {
    const back = businessJobReturnPaths("{ORDER_ID}");
    return { success_url: `${origin}${back.success}`, cancel_url: `${origin}${back.cancel}` };
  }
  const safe =
    return_path && /^\/[A-Za-z0-9/_-]{0,200}$/.test(return_path) ? return_path : "/humans/jobs";
  const base = safe.replace(/\/+$/, "") || "/humans/jobs";
  return {
    success_url: `${origin}${base}/{ORDER_ID}?paid=1`,
    cancel_url: `${origin}${base}?cancelled=1`,
  };
}

export async function postCreatorOrderQuote(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const parsed = QuoteSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, "bad_request", "Tell Zavi which package, offer or applicant to price.");
    return;
  }
  try {
    const quote = await quoteCreatorBooking({
      tenant_id: auth.tenant_id,
      target: parsed.data.target,
      due_at: parsed.data.due_at,
      brief_id: parsed.data.brief_id,
      product_needed: parsed.data.product_needed,
    });
    res.json({ quote });
  } catch (e) {
    await handleServiceError(res, auth.tenant_id, "quote", e);
  }
}

export async function postCreatorOrder(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const parsed = CreateSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, "bad_request", "Tell Zavi which package, offer or applicant to book.");
    return;
  }
  const urls = returnUrls(parsed.data.return_path);
  const brief_snapshot_override =
    parsed.data.target.source === "booking"
      ? bookingBriefSnapshot({ title: parsed.data.brief_title, brief: parsed.data.brief })
      : undefined;
  try {
    const started = await startCreatorCheckout({
      tenant_id: auth.tenant_id,
      user_id: auth.user_id,
      target: parsed.data.target,
      due_at: parsed.data.due_at,
      product_needed: parsed.data.product_needed,
      large_amount_confirmed: parsed.data.large_amount_confirmed,
      success_url: urls.success_url,
      cancel_url: urls.cancel_url,
      brief_snapshot_override,
      brief_id: parsed.data.brief_id,
    });
    res.json({
      order_id: started.order_id,
      checkout_url: started.checkout_url,
      quote: started.quote,
      reused_existing: started.reused_existing,
    });
  } catch (e) {
    await handleServiceError(res, auth.tenant_id, "create", e);
  }
}

export async function postCreatorOrderFulfil(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const id = Uuid.safeParse(req.params.orderId);
  if (!id.success) {
    fail(res, 400, "bad_order_id", "That is not an order id.");
    return;
  }
  try {
    const result = await fulfilCreatorCheckout({
      tenant_id: auth.tenant_id,
      order_id: id.data,
    });
    res.json(result);
  } catch (e) {
    await handleServiceError(res, auth.tenant_id, "fulfil", e);
  }
}

export async function postCreatorOrderCheckout(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const id = Uuid.safeParse(req.params.orderId);
  if (!id.success) {
    fail(res, 400, "bad_order_id", "That is not an order id.");
    return;
  }
  try {
    await refuseAgentHireCheckout(auth.tenant_id, id.data);
    res.json(await resumeOrderCheckout({ tenant_id: auth.tenant_id, order_id: id.data }));
  } catch (e) {
    await handleServiceError(res, auth.tenant_id, "checkout_resume", e);
  }
}

export async function getCreatorOrders(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    res.json(await listBusinessJobs(auth.tenant_id));
  } catch (e) {
    await handleServiceError(res, auth.tenant_id, "list", e);
  }
}

export async function getCreatorOrder(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const id = Uuid.safeParse(req.params.orderId);
  if (!id.success) {
    fail(res, 400, "bad_order_id", "That is not an order id.");
    return;
  }
  try {
    const detail = await getBusinessJob(auth.tenant_id, id.data, undefined, auth.user_id);
    if (!detail) {
      fail(res, 404, "creator_order_not_found", "That job is not in this workspace.");
      return;
    }
    res.json(detail);
  } catch (e) {
    await handleServiceError(res, auth.tenant_id, "detail", e);
  }
}

const ACTION_STATUS: Record<string, number> = {
  order_not_found: 404,
  unknown_trigger: 400,
  illegal_transition: 409,
  wrong_actor: 403,
  wrong_source: 409,
  missing_argument: 400,
  invalid_amount: 400,
  conflict: 409,
  money_needs_staff: 409,
  revision_limit_reached: 409,
};

export async function postCreatorOrderAction(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const id = Uuid.safeParse(req.params.orderId);
  if (!id.success) {
    fail(res, 400, "bad_order_id", "That is not an order id.");
    return;
  }
  const parsed = ActionSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, "bad_action", "That is not something you can do to a job.");
    return;
  }
  try {
    const result = await runBusinessAction({
      tenant_id: auth.tenant_id,
      order_id: id.data,
      action: parsed.data.action,
      user_id: auth.user_id,
      note: parsed.data.note ?? null,
    });
    if (!result.ok) {
      fail(res, ACTION_STATUS[result.code] ?? 400, result.code, result.message);
      return;
    }
    const detail = await getBusinessJob(auth.tenant_id, id.data, undefined, auth.user_id);
    res.json({
      ok: true,
      from: result.from,
      to: result.to,
      needs_staff_review: result.needs_staff_review,
      payout_waiting: result.payout_waiting,
      library_asset_created: result.library_asset_created ?? false,
      detail,
    });
  } catch (e) {
    await handleServiceError(res, auth.tenant_id, "action", e);
  }
}
