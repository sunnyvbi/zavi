
import type { Request, Response } from "express";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import { writeStaffAudit } from "@/services/staff/audit";
import { HumanError } from "@/services/humans/contract";
import { getMemberDetail, setVettingState } from "@/services/humans/store";
import {
  applyCreatorOrderTransition,
  type ApplyCreatorOrderTransitionResult,
} from "@/services/creators/order-transitions";
import {
  CreatorStaffError,
  getCreatorDisputeDetail,
  getStaffCreatorProfile,
  listOpenCreatorDisputes,
  listRemovablePendingOrders,
  listUntouchedInFlightOrders,
  resolveMediationTarget,
  withdrawOpenApplications,
  withdrawOpenOffers,
  type MediationOutcome,
  type PendingOrderRef,
} from "@/services/creators/staff-console";
import { realCreatorLibraryPort } from "@/services/creators/s7-ports";
import { logEvent } from "@/services/logging/logEvent";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ResolveBody = z
  .object({
    outcome: z.enum(["pay_full", "pay_part", "refund"]),
    creator_amount_cents: z.number().int().positive().max(10_000_000).optional(),
    refund_amount_cents: z.number().int().positive().max(20_000_000).optional(),
    note: z.string().trim().max(4000).optional(),
  })
  .strict();

const RemoveBody = z
  .object({
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();

function badRequest(res: Response, code: string, message: string): void {
  res.status(400).json({ error: { code, message } });
}

function sendError(res: Response, e: unknown): void {
  if (e instanceof CreatorStaffError || e instanceof HumanError) {
    res.status(e.status).json({ error: { code: e.code, message: e.message } });
    return;
  }
  console.error(`[admin/creator-network] unexpected failure: ${(e as Error)?.message ?? e}`);
  res.status(500).json({
    error: {
      code: "creator_staff_unavailable",
      message: "The creator staff console is temporarily unavailable.",
    },
  });
}

const TRANSITION_STATUS: Record<string, number> = {
  order_not_found: 404,
  unknown_trigger: 400,
  illegal_transition: 409,
  wrong_actor: 409,
  wrong_source: 409,
  missing_argument: 400,
  invalid_amount: 400,
  money_needs_staff: 409,
  conflict: 409,
};

export async function staffCreatorDisputeQueue(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  try {
    const items = await listOpenCreatorDisputes();
    res.json({
      items,
      order: "oldest first",
    });
  } catch (e) {
    sendError(res, e);
  }
}

export async function staffCreatorDisputeDetail(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const id = String(req.params.id ?? "");
  if (!UUID_RE.test(id)) return badRequest(res, "invalid_id", "id must be a UUID");
  try {
    res.json(await getCreatorDisputeDetail(id));
  } catch (e) {
    sendError(res, e);
  }
}

async function disputeStillOpen(
  disputeId: string,
  outcome: MediationOutcome,
  fallback: boolean,
): Promise<boolean> {
  try {
    await resolveMediationTarget(disputeId, outcome);
    return true;
  } catch (e) {
    if (e instanceof CreatorStaffError && e.code === "dispute_not_open") return false;
    return fallback;
  }
}

export async function staffCreatorDisputeResolve(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const id = String(req.params.id ?? "");
  if (!UUID_RE.test(id)) return badRequest(res, "invalid_id", "id must be a UUID");

  const parsed = ResolveBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return badRequest(res, "validation", parsed.error.issues[0]?.message ?? "invalid body");
  }
  const body = parsed.data;
  const outcome = body.outcome as MediationOutcome;

  if (outcome === "pay_part") {
    if (body.creator_amount_cents === undefined || body.refund_amount_cents === undefined) {
      return badRequest(
        res,
        "amounts_required",
        "Paying part needs both numbers: what the creator keeps, and what goes back to the business card.",
      );
    }
  } else if (
    body.creator_amount_cents !== undefined ||
    body.refund_amount_cents !== undefined
  ) {
    return badRequest(
      res,
      "amounts_not_allowed",
      "Amounts only apply when paying part. Paying in full and refunding both use the order's own totals.",
    );
  }

  try {
    const target = await resolveMediationTarget(id, outcome);

    const result: ApplyCreatorOrderTransitionResult = await applyCreatorOrderTransition({
      tenant_id: target.tenant_id,
      order_id: target.order_id,
      trigger: target.trigger,
      actor: "staff",
      actor_user_id: staff.user_id,
      ...(outcome === "pay_part"
        ? {
            creator_amount_cents: body.creator_amount_cents,
            refund_amount_cents: body.refund_amount_cents,
          }
        : {}),
      note: body.note ?? null,
    });

    if (!result.ok) {
      res
        .status(TRANSITION_STATUS[result.code] ?? 409)
        .json({ error: { code: result.code, message: result.message } });
      return;
    }

    await writeStaffAudit({
      actor_user_id: staff.user_id,
      actor_email: staff.email,
      action: "creator_dispute_resolved",
      target_table: "creator_disputes",
      target_id: id,
      tenant_id: target.tenant_id,
      meta: {
        creator_order_id: target.order_id,
        outcome,
        trigger: target.trigger,
        creator_amount_cents: body.creator_amount_cents ?? null,
        refund_amount_cents: body.refund_amount_cents ?? null,
        from: result.from,
        to: result.to,
        needs_staff_review: result.needs_staff_review,
        payout_waiting: result.payout_waiting,
      },
    });

    if ((outcome === "pay_full" || outcome === "pay_part") && result.order.status === "completed") {
      try {
        await realCreatorLibraryPort.createLibraryAssetOnApproval(target.tenant_id, target.order_id);
      } catch (e) {
        await logEvent({
          level: "warn",
          source: "creator.mediation",
          code: "mediation_library_failed",
          message: String((e as Error)?.message ?? e).slice(0, 300),
          tenant_id: target.tenant_id,
          meta: { creator_order_id: target.order_id, outcome },
        }).catch(() => {});
      }
    }

    const moneyFrozen = await disputeStillOpen(id, outcome, result.needs_staff_review);

    res.json({
      dispute_id: id,
      outcome,
      order_id: result.order.id,
      status: result.order.status,
      closed_reason: result.order.closed_reason,
      payout_status: result.order.payout_status,
      payout_amount_cents: result.order.payout_amount_cents,
      money_frozen: moneyFrozen,
      needs_staff_review: result.needs_staff_review,
      payout_waiting: result.payout_waiting,
      payout_sent: result.payout_sent ?? null,
    });
  } catch (e) {
    sendError(res, e);
  }
}

export async function staffCreatorDetail(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const id = String(req.params.id ?? "");
  if (!UUID_RE.test(id)) return badRequest(res, "invalid_id", "id must be a UUID");
  try {
    const [vetting, creator] = await Promise.all([
      getMemberDetail(id),
      getStaffCreatorProfile(id),
    ]);
    res.json({
      member: vetting.member,
      handles: vetting.handles,
      pii: vetting.pii,
      collisions: vetting.collisions,
      creator,
    });
  } catch (e) {
    sendError(res, e);
  }
}

export type RemovalCascadeResult = {
  storefront_hidden: boolean;
  applications_withdrawn: number;
  offers_withdrawn: number;
  pending_orders_cancelled: PendingOrderRef[];
  pending_orders_failed: Array<PendingOrderRef & { code: string; message: string }>;
  in_progress_untouched: PendingOrderRef[];
};

export async function staffCreatorRemove(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const id = String(req.params.id ?? "");
  if (!UUID_RE.test(id)) return badRequest(res, "invalid_id", "id must be a UUID");

  const parsed = RemoveBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return badRequest(
      res,
      "reason_required",
      "Removing a creator must include a reason they can read.",
    );
  }
  const reason = parsed.data.reason;

  try {
    const inFlight = await listUntouchedInFlightOrders(id);

    const member = await setVettingState(id, "rejected", reason);

    const applications_withdrawn = await withdrawOpenApplications(id);
    const offers_withdrawn = await withdrawOpenOffers(id);

    const pending = await listRemovablePendingOrders(id);
    const cancelled: PendingOrderRef[] = [];
    const failed: Array<PendingOrderRef & { code: string; message: string }> = [];
    for (const p of pending) {
      const result = await applyCreatorOrderTransition({
        tenant_id: p.tenant_id,
        order_id: p.order_id,
        trigger: "creator_removed",
        actor: "staff",
        actor_user_id: staff.user_id,
        note: reason,
      });
      if (result.ok) cancelled.push(p);
      else failed.push({ ...p, code: result.code, message: result.message });
    }

    const cascade: RemovalCascadeResult = {
      storefront_hidden: true,
      applications_withdrawn,
      offers_withdrawn,
      pending_orders_cancelled: cancelled,
      pending_orders_failed: failed,
      in_progress_untouched: inFlight,
    };

    await writeStaffAudit({
      actor_user_id: staff.user_id,
      actor_email: staff.email,
      action: "creator_removed",
      target_table: "human_members",
      target_id: id,
      meta: {
        rejected_reason: member.rejected_reason,
        applications_withdrawn,
        offers_withdrawn,
        pending_orders_cancelled: cancelled.length,
        pending_orders_failed: failed.length,
        in_progress_untouched: inFlight.length,
      },
    });

    res.json({ member, cascade });
  } catch (e) {
    sendError(res, e);
  }
}
