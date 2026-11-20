
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { globalClient } from "@/services/tenant-client";
import { creatorPayoutCountrySupported } from "@/services/creators/payout-countries";
import {
  getReviewForOrder,
  loadCreatorReputation,
  submitCreatorReview,
  updateCreatorReview,
  type ReviewWriteFailure,
  type ReviewWriteResult,
} from "@/services/humans/creatorReviews";

const OrderIdParam = z.object({ orderId: z.string().uuid() });

const ReviewBody = z.object({
  communication: z.number().int().min(1).max(5),
  timeliness: z.number().int().min(1).max(5),
  satisfaction: z.number().int().min(1).max(5),
  body: z.string().max(2000).nullable().optional(),
});

const FAILURE_STATUS: Record<ReviewWriteFailure, number> = {
  order_not_found: 404,
  review_not_found: 404,
  order_not_completed: 409,
  review_already_exists: 409,
  review_frozen: 409,
  creator_cannot_review: 403,
};

const FAILURE_MESSAGE: Record<ReviewWriteFailure, string> = {
  order_not_found: "Job not found.",
  review_not_found: "You have not reviewed this job yet.",
  order_not_completed: "You can review this creator once the job is complete.",
  review_already_exists: "You have already reviewed this job.",
  review_frozen: "Reviews can be edited for 7 days. This one is now final.",
  creator_cannot_review: "A creator cannot review their own job.",
};

function sendWriteResult(res: Response, result: ReviewWriteResult): void {
  if (result.ok) {
    res.json({ ok: true, review_id: result.review_id });
    return;
  }
  res
    .status(FAILURE_STATUS[result.code])
    .json({ error: { code: result.code, message: FAILURE_MESSAGE[result.code] } });
}

export async function getOrderReview(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const parsed = OrderIdParam.safeParse({ orderId: req.params.orderId });
  if (!parsed.success) {
    res.status(400).json({ error: { code: "bad_order_id", message: "order id is required" } });
    return;
  }
  const review = await getReviewForOrder(auth.tenant_id, parsed.data.orderId);
  res.json({ review });
}

export async function postOrderReview(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const id = OrderIdParam.safeParse({ orderId: req.params.orderId });
  if (!id.success) {
    res.status(400).json({ error: { code: "bad_order_id", message: "order id is required" } });
    return;
  }
  const body = ReviewBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({
      error: {
        code: "bad_review",
        message: "Rate communication, timeliness and satisfaction from 1 to 5.",
      },
    });
    return;
  }
  sendWriteResult(
    res,
    await submitCreatorReview({
      tenantId: auth.tenant_id,
      actorUserId: auth.user_id,
      orderId: id.data.orderId,
      input: body.data,
    }),
  );
}

export async function patchOrderReview(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const id = OrderIdParam.safeParse({ orderId: req.params.orderId });
  if (!id.success) {
    res.status(400).json({ error: { code: "bad_order_id", message: "order id is required" } });
    return;
  }
  const body = ReviewBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({
      error: {
        code: "bad_review",
        message: "Rate communication, timeliness and satisfaction from 1 to 5.",
      },
    });
    return;
  }
  sendWriteResult(
    res,
    await updateCreatorReview({
      tenantId: auth.tenant_id,
      orderId: id.data.orderId,
      input: body.data,
    }),
  );
}

const SlugParam = z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,38}[a-z0-9]$/) });

export async function getCreatorReputation(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const parsed = SlugParam.safeParse({ slug: String(req.params.slug ?? "").toLowerCase() });
  if (!parsed.success) {
    res.status(404).json({ error: { code: "creator_not_found", message: "Creator not found." } });
    return;
  }
  const { data } = await globalClient()
    .from("human_members")
    .select("id, vetting_state, country_code")
    .eq("slug", parsed.data.slug)
    .maybeSingle();
  const member = data as { id: string; vetting_state: string; country_code: string | null } | null;
  if (!member || member.vetting_state !== "approved" || !creatorPayoutCountrySupported(member.country_code)) {
    res.status(404).json({ error: { code: "creator_not_found", message: "Creator not found." } });
    return;
  }
  res.json(await loadCreatorReputation(member.id));
}
