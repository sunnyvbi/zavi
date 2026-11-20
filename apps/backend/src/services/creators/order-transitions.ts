
import { logEvent } from "@/services/logging/logEvent";
import { alert } from "@/services/logging/alert";
import { armCreatorDeadlineTimer, armCreatorPayoutBufferTimer, requestCreatorBookingLink } from "./arm-timers";
import { hasCompletedJobWithCreator } from "./booking-db";
import { realCreatorLibraryPort, type CreatorLibraryPort } from "./s7-ports";
import { releaseApplicationAfterCancelledOrder, resolveBusinessName } from "./briefs-db";
import { hireFromBookedBrief } from "./brief-applications";
import {
  MAX_REVISION_ROUNDS,
  revisionsUsed,
  transitionCreatorOrder,
  type CreatorMoneyEffect,
  type CreatorOrderActor,
  type CreatorOrderStatus,
  type CreatorOrderTransitionDecision,
  type CreatorOrderTrigger,
} from "./order-state";
import {
  agreedDueAt,
  canAskZaviAfterAutoAccept,
  orderDeadlineForRow,
  resumedAfterCancelHold,
  payoutBufferEnd,
  type CreatorOrderDeadline,
} from "./deadlines";
import {
  claimOrderDeadline,
  submissionRounds,
  hasOpenCreatorDispute,
  discardOpenCreatorDispute,
  latestSubmissionAt,
  loadOrderForState,
  markMissedDeadline,
  openCreatorDispute,
  releaseOrderDeadlineLease,
  resolveCreatorDispute,
  writeOrderState,
  type CreatorDisputeOpen,
  type CreatorOrderStatePatch,
  type CreatorOrderStateRow,
} from "./orders-db";
import { payoutCauseForClose } from "./payout-release";
import type { SettleUnpaidCheckoutResult } from "./checkout-expiry";
import { settleCreatorHire } from "@/services/decisions/creator-hire-budget";
import {
  realCreatorMoneyPort,
  realCreatorNotifyPort,
  type CreatorMoneyPort,
  type CreatorNotifyPort,
  type CreatorNotifyVars,
} from "./ports";

export type CreatorOrderDeps = {
  loadOrder: typeof loadOrderForState;
  writeOrder: typeof writeOrderState;
  latestSubmissionAt: typeof latestSubmissionAt;
  submissionRounds: typeof submissionRounds;
  openDispute: typeof openCreatorDispute;
  resolveDispute: typeof resolveCreatorDispute;
  hasOpenDispute: typeof hasOpenCreatorDispute;
  discardDispute?: typeof discardOpenCreatorDispute;
  markMissedDeadline: typeof markMissedDeadline;
  money: CreatorMoneyPort;
  notify: CreatorNotifyPort;
  businessName: typeof resolveBusinessName;
  priorCompletedWithCreator: typeof hasCompletedJobWithCreator;
  armDeadline: (args: {
    order_id: string;
    tenant_id: string;
    deadline: CreatorOrderDeadline;
  }) => Promise<void>;
  armPayoutBuffer: (args: {
    order_id: string;
    tenant_id: string;
    payout_ready_at: string;
  }) => Promise<void>;
  now: () => Date;
  log: typeof logEvent;
  alert?: typeof alert;
  settleUnpaidCheckout?: (row: CreatorOrderStateRow) => Promise<SettleUnpaidCheckoutResult>;
  releaseApplication?: typeof releaseApplicationAfterCancelledOrder;
  settleHire?: typeof settleCreatorHire;
  hireFromBooking?: typeof hireFromBookedBrief;
  retryBookingLink?: typeof requestCreatorBookingLink;
};

export const realCreatorOrderDeps: CreatorOrderDeps = {
  releaseApplication: releaseApplicationAfterCancelledOrder,
  hireFromBooking: hireFromBookedBrief,
  retryBookingLink: requestCreatorBookingLink,
  settleHire: settleCreatorHire,
  loadOrder: loadOrderForState,
  writeOrder: writeOrderState,
  latestSubmissionAt,
  submissionRounds,
  openDispute: openCreatorDispute,
  resolveDispute: resolveCreatorDispute,
  hasOpenDispute: hasOpenCreatorDispute,
  discardDispute: discardOpenCreatorDispute,
  markMissedDeadline,
  money: realCreatorMoneyPort,
  notify: realCreatorNotifyPort,
  businessName: resolveBusinessName,
  priorCompletedWithCreator: hasCompletedJobWithCreator,
  armDeadline: armCreatorDeadlineTimer,
  armPayoutBuffer: armCreatorPayoutBufferTimer,
  now: () => new Date(),
  log: logEvent,
  alert,
};

export type ApplyCreatorOrderTransitionArgs = {
  tenant_id: string;
  order_id: string;
  trigger: CreatorOrderTrigger;
  actor?: CreatorOrderActor;
  actor_user_id?: string | null;
  dispute?: CreatorDisputeOpen;
  creator_amount_cents?: number;
  refund_amount_cents?: number;
  requested_due_at?: string;
  submission_version?: number;
  note?: string | null;
  expected_deadline?: { at: string | null; kind: string | null };
};

export type ApplyCreatorOrderTransitionResult =
  | {
      ok: false;
      code:
        | "order_not_found"
        | "unknown_trigger"
        | "illegal_transition"
        | "wrong_actor"
        | "wrong_source"
        | "missing_argument"
        | "invalid_amount"
        | "money_needs_staff"
        | "revision_limit_reached"
        | "conflict";
      message: string;
    }
  | {
      ok: true;
      order: CreatorOrderStateRow;
      trigger: CreatorOrderTrigger;
      from: CreatorOrderStatus;
      to: CreatorOrderStatus;
      deadline: CreatorOrderDeadline | null;
      money: { effect: CreatorMoneyEffect; result: unknown }[];
      needs_staff_review: boolean;
      payout_waiting: boolean;
      payout_sent?: boolean | null;
    };

function jobTitle(order: CreatorOrderStateRow): string | null {
  const snap = order.package_snapshot;
  if (!snap) return null;
  const t = snap["title"];
  return typeof t === "string" && t.trim().length > 0 ? t : null;
}

function refundOutcome(
  moneyLog: { effect: CreatorMoneyEffect; result: unknown }[],
): { cents: number | null; reason: "refund_on_hold" | "refund_already_done" | null } {
  for (const { effect, result } of moneyLog) {
    if (effect.kind !== "refund") continue;
    const r = (result ?? {}) as { refunded_cents?: unknown; blocked_reason?: unknown; already_refunded?: unknown };
    const cents = r.refunded_cents;
    const positive = typeof cents === "number" && Number.isFinite(cents) && cents > 0;
    if (r.blocked_reason === "charge_disputed") return { cents: null, reason: "refund_on_hold" };
    if (positive) return { cents: cents as number, reason: null };
    if (r.already_refunded === true) return { cents: null, reason: "refund_already_done" };
    return { cents: null, reason: null };
  }
  return { cents: null, reason: null };
}

function creatorName(order: CreatorOrderStateRow): string | null {
  const snap = (order.package_snapshot ?? {}) as Record<string, unknown>;
  const n = snap["creator_display_name"];
  return typeof n === "string" && n.trim().length > 0 ? n : null;
}

export function baseVars(order: CreatorOrderStateRow, business_name: string | null): CreatorNotifyVars {
  return {
    job_title: jobTitle(order),
    price_cents: order.price_cents,
    payout_cents: order.payout_amount_cents ?? order.creator_payout_cents,
    business_total_cents: order.business_total_cents,
    business_name,
    creator_name: creatorName(order),
  };
}

const PRE_PERSIST: readonly CreatorMoneyEffect["kind"][] = [
  "capture",
  "cancel_hold",
  "refund",
  "freeze_payout",
];

export async function applyCreatorOrderTransition(
  args: ApplyCreatorOrderTransitionArgs,
  deps: CreatorOrderDeps = realCreatorOrderDeps,
): Promise<ApplyCreatorOrderTransitionResult> {
  const order = await deps.loadOrder(args.tenant_id, args.order_id);
  if (!order) {
    return { ok: false, code: "order_not_found", message: "That order does not exist here." };
  }

  const mediatingClosedOrder =
    order.status === "completed" && args.trigger.startsWith("mediation_");
  const decision = transitionCreatorOrder({
    status: order.status,
    source: order.source,
    trigger: args.trigger,
    actor: args.actor,
    has_open_dispute: mediatingClosedOrder
      ? await deps.hasOpenDispute(order.tenant_id, order.id)
      : false,
    status_before_cancel_request: order.status_before_cancel_request,
  });
  if (!decision.ok) {
    return { ok: false, code: decision.code, message: decision.message };
  }

  const guard = checkArgs(decision, order, args, deps.now());
  if (guard) return guard;

  if (args.expected_deadline && deadlineMoved(args.expected_deadline, order)) {
    return {
      ok: false,
      code: "conflict",
      message: "This order's deadline changed after the timer claimed it; nothing was done.",
    };
  }

  let revisionRound: number | null = null;
  if (decision.trigger === "request_revision") {
    const used = revisionsUsed(await deps.submissionRounds(order.tenant_id, order.id), order.status);
    revisionRound = used + 1;
    if (used >= MAX_REVISION_ROUNDS) {
      return {
        ok: false,
        code: "revision_limit_reached",
        message: `You have already asked for changes ${MAX_REVISION_ROUNDS} times on this job. Approve the work, or ask Zavi to step in.`,
      };
    }
  }

  if (decision.trigger === "submit" && !(Number.isInteger(args.submission_version) && (args.submission_version as number) > 0)) {
    return { ok: false, code: "missing_argument", message: "A delivery has to say which version it is." };
  }
  const submittedVersion = decision.trigger === "submit" ? (args.submission_version as number) : null;

  const now = deps.now();
  const nowIso = now.toISOString();
  const moneyLog: { effect: CreatorMoneyEffect; result: unknown }[] = [];
  let needsStaff = false;
  const staffReasons: string[] = [];
  let payoutWaiting = false;
  let transferSent = false;
  let transferInFlight = false;

  for (const effect of decision.money) {
    if (!PRE_PERSIST.includes(effect.kind)) continue;

    if (effect.kind === "capture") {
      const res = await deps.money.capture({
        tenant_id: order.tenant_id,
        order_id: order.id,
        creator_country: await creatorCountry(order, deps),
        cause: effect.cause,
      });
      moneyLog.push({ effect, result: res });
      if (!res.ok) {
        await deps.log({
          level: "warn",
          source: "creator.order",
          code: "capture_failed",
          tenant_id: order.tenant_id,
          meta: { creator_order_id: order.id, reject_reason: res.failure_code ?? "unknown" },
        });
        return applyCreatorOrderTransition(
          { tenant_id: args.tenant_id, order_id: args.order_id, trigger: "capture_failed", actor: "system" },
          deps,
        );
      }
      await settleHireFor(deps, order.tenant_id, order.id, "spent");
    }

    if (effect.kind === "cancel_hold") {
      const res = await deps.money.cancelHold({
        tenant_id: order.tenant_id,
        order_id: order.id,
        cause: effect.cause,
      });
      moneyLog.push({ effect, result: res });
      if (!res.ok) {
        await deps.log({
          level: "error",
          source: "creator.order",
          code: "cancel_hold_already_captured",
          tenant_id: order.tenant_id,
          meta: { creator_order_id: order.id, op: decision.trigger },
        });
        return {
          ok: false,
          code: "money_needs_staff",
          message:
            "This order was already charged, so the hold cannot simply be released. Zavi staff have to refund it.",
        };
      }
      if (res.payment_intent_id === null) await settleHireOrThrow(deps, order.tenant_id, order.id);
      else await settleHireFor(deps, order.tenant_id, order.id, "released");
    }

    if (effect.kind === "refund") {
      const amount =
        effect.amount === "remainder" ? (args.refund_amount_cents as number) : undefined;
      const res = await deps.money.refund({
        tenant_id: order.tenant_id,
        order_id: order.id,
        cause: effect.cause,
        ...(amount !== undefined ? { amount_cents: amount } : {}),
        actor_kind: args.actor === "staff" ? "staff" : args.actor === "creator" ? "creator" : args.actor === "business" ? "tenant" : "system",
        actor_user_id: args.actor_user_id ?? null,
      });
      moneyLog.push({ effect, result: res });
      if (res.needs_staff_review) {
        needsStaff = true;
        staffReasons.push(res.blocked_reason ? `refund_${res.blocked_reason}` : "refund_needs_review");
      }
      if (res.blocked_reason && decision.money.some((m) => m.kind === "transfer")) {
        await deps
          .log({
            level: "error",
            source: "creator.order",
            code: "refund_blocked_before_transfer",
            tenant_id: order.tenant_id,
            meta: { creator_order_id: order.id, op: decision.trigger, reject_reason: res.blocked_reason },
          })
          .catch(() => {});
        return {
          ok: false,
          code: "money_needs_staff",
          message:
            "The business's refund is blocked by a chargeback on this payment, so the creator was not paid and nothing changed. Settle the chargeback at Stripe first.",
        };
      }
    }

    if (effect.kind === "freeze_payout") {
      const res = await deps.openDispute({
        tenant_id: order.tenant_id,
        order_id: order.id,
        dispute: args.dispute as CreatorDisputeOpen,
      });
      moneyLog.push({ effect, result: res });
    }
  }

  const patch = buildPatch(decision, order, args, nowIso);
  const nextStatus = decision.to;
  const heldSince =
    (decision.trigger === "cancel_declined" || decision.trigger === "cancel_revoked") && order.cancel_requested_at
      ? order.cancel_requested_at
      : null;
  if (heldSince && nextStatus === "in_progress" && order.due_at) {
    patch.due_at = resumedAfterCancelHold(order.due_at, heldSince, now);
  }
  const submittedAt =
    nextStatus === "submitted" ? await deps.latestSubmissionAt(order.tenant_id, order.id) : null;
  const deadline = orderDeadlineForRow(
    {
      status: nextStatus,
      source: order.source,
      created_at:
        nextStatus === "awaiting_acceptance" && order.status === "checkout_pending" ? nowIso : order.created_at,
      due_at: (patch.due_at ?? order.due_at) as string | null,
      cancel_requested_at: patch.cancel_requested_at ?? order.cancel_requested_at,
      last_submission_at:
        heldSince && submittedAt ? resumedAfterCancelHold(submittedAt, heldSince, now) : submittedAt,
    },
    now,
  );
  patch.next_deadline_at = deadline?.deadline_at ?? null;
  patch.next_deadline_kind = deadline?.kind ?? null;
  patch.lease_until = null;

  const written = await deps.writeOrder({
    tenant_id: order.tenant_id,
    order_id: order.id,
    expected_status: order.status,
    patch,
  });
  if (!written) {
    const strandedDispute =
      decision.to === "in_dispute" && moneyLog.some((m) => m.effect.kind === "freeze_payout" && m.result === "opened");
    if (strandedDispute) {
      let freezeKept = false;
      await safely(deps, async () => {
        const now = await deps.loadOrder(args.tenant_id, args.order_id);
        if (!now || now.status === "in_dispute") return;
        const reliedOn = now.status === "completed" && now.closed_reason === "auto_accepted";
        if (reliedOn || !deps.discardDispute) {
          freezeKept = true;
          if (deps.alert) {
            await deps.alert({
              source: "creator-order",
              code: "creator_dispute_opened",
              tenant_id: now.tenant_id,
              msg: `Creator order ${now.id}: a step-in lost the race to a change (now ${now.status}${now.closed_reason ? `, ${now.closed_reason}` : ""}). The dispute row is kept and the payout stays frozen until staff resolve it in Admin, Creator mediation.`,
              email: { dedupeKey: `creator_dispute_opened:${now.id}` },
            });
          }
          return;
        }
        await deps.discardDispute({ tenant_id: now.tenant_id, order_id: now.id });
        const after = await deps.loadOrder(args.tenant_id, args.order_id);
        if (after?.status === "in_dispute") {
          await deps.openDispute({
            tenant_id: after.tenant_id,
            order_id: after.id,
            dispute: args.dispute as CreatorDisputeOpen,
          });
          if (deps.alert) {
            await deps.alert({
              source: "creator-order",
              code: "creator_dispute_opened",
              tenant_id: after.tenant_id,
              msg: `Creator order ${after.id}: a step-in that lost a race removed the open dispute while the other side's step-in moved the order to in_dispute. The dispute row was written again so the payout stays frozen; check it in Admin, Creator mediation.`,
              email: { dedupeKey: `creator_dispute_opened:${after.id}` },
            });
          }
          return;
        }
        const cause = now.status === "completed" && now.payout_status === "ready" ? payoutCauseForClose(now.closed_reason) : null;
        if (cause !== "approval" && cause !== "mediation") return;
        const sent = await deps.money.transfer({ tenant_id: now.tenant_id, order_id: now.id, cause });
        if (sent.ok) {
          await deps.notify.notify({
            recipient: { kind: "creator", human_member_id: now.human_member_id },
            event: "paid",
            order_id: now.id,
            vars: baseVars(now, null),
          });
          return;
        }
        if (sent.reason === "claim_lost") return;
        if (sent.reason === "awaiting_payout_account" || sent.reason === "transfers_capability_inactive") {
          const parked = await deps.writeOrder({
            tenant_id: now.tenant_id,
            order_id: now.id,
            expected_status: now.status,
            expected_payout_status: "ready",
            patch: { payout_status: "awaiting_payout_account" },
          });
          if (parked) {
            await deps.notify.notify({
              recipient: { kind: "creator", human_member_id: parked.human_member_id },
              event: "payout_setup_needed",
              order_id: parked.id,
              vars: baseVars(parked, null),
            });
          }
          return;
        }
        if (deps.alert) {
          await deps.alert({
            source: "creator-order",
            code: "creator_order_needs_staff",
            tenant_id: now.tenant_id,
            msg: `Creator order ${now.id}: a step-in lost the race to ${now.closed_reason}; the payout retry was refused (${sent.reason}). Check it in Stripe and the staff console.`,
            email: { dedupeKey: `creator_order_needs_staff:${now.id}:stranded_dispute` },
          });
        }
      });
      return {
        ok: false,
        code: "conflict",
        message: freezeKept
          ? "This job was accepted a moment ago, but Zavi was still asked to step in and the payout waits until Zavi decides. Reload it to see where it stands."
          : "This job changed a moment ago, so Zavi was not asked to step in. Reload it to see where it stands.",
      };
    }
    return {
      ok: false,
      code: "conflict",
      message: "This order changed while the request was in flight. Reload it and try again.",
    };
  }

  if (decision.trigger.startsWith("mediation_")) {
    try {
      await deps.resolveDispute({
        tenant_id: written.tenant_id,
        order_id: written.id,
        outcome:
          decision.trigger === "mediation_pay_full"
            ? "pay_full"
            : decision.trigger === "mediation_pay_part"
              ? "pay_part"
              : "refund",
        creator_amount_cents: args.creator_amount_cents ?? null,
        refund_amount_cents: args.refund_amount_cents ?? null,
        resolved_by_staff_id: args.actor_user_id ?? null,
        resolution_note: args.note ?? null,
      });
    } catch (e) {
      needsStaff = true;
      staffReasons.push("dispute_resolve_failed");
      await deps
        .log({
          level: "error",
          source: "creator.order",
          code: "dispute_resolve_failed",
          message: (e as Error).message.slice(0, 300),
          tenant_id: written.tenant_id,
          meta: { creator_order_id: written.id, op: decision.trigger },
        })
        .catch(() => {});
    }
  }

  for (const effect of decision.money) {
    if (effect.kind !== "transfer") continue;
    let res: Awaited<ReturnType<CreatorMoneyPort["transfer"]>>;
    try {
      res = await deps.money.transfer({
        tenant_id: written.tenant_id,
        order_id: written.id,
        cause: effect.cause,
      });
    } catch (e) {
      needsStaff = true;
      staffReasons.push("transfer_failed");
      await deps
        .log({
          level: "error",
          source: "creator.order",
          code: "transfer_failed",
          message: (e as Error).message.slice(0, 300),
          tenant_id: written.tenant_id,
          meta: { creator_order_id: written.id, op: decision.trigger },
        })
        .catch(() => {});
      continue;
    }
    moneyLog.push({ effect, result: res });
    if (res.ok && typeof res.transfer_id === "string" && res.transfer_id.length > 0) {
      transferSent = true;
    }
    if (res.ok && !res.recorded) {
      needsStaff = true;
      staffReasons.push("transfer_unrecorded");
    }
    if (!res.ok) {
      if (res.reason === "awaiting_payout_account" || res.reason === "transfers_capability_inactive") {
        const parked = await deps.writeOrder({
          tenant_id: written.tenant_id,
          order_id: written.id,
          expected_status: written.status,
          expected_payout_status: "ready",
          patch: { payout_status: "awaiting_payout_account" },
        });
        if (!parked) continue;
        payoutWaiting = true;
        await safely(deps, () =>
          deps.notify.notify({
            recipient: { kind: "creator", human_member_id: written.human_member_id },
            event: "payout_setup_needed",
            order_id: written.id,
            vars: baseVars(written, null),
          }),
        );
      } else {
        const heldByDispute = res.reason === "claim_lost" && (await deps.hasOpenDispute(written.tenant_id, written.id).catch(() => true));
        if (res.reason === "claim_lost" && !heldByDispute) transferInFlight = true;
        if (res.reason !== "claim_lost" || heldByDispute) {
          needsStaff = true;
          staffReasons.push(heldByDispute ? "transfer_held_by_open_dispute" : `transfer_${res.reason}`);
        }
        await deps.log({
          level: res.reason === "claim_lost" ? "info" : "warn",
          source: "creator.order",
          code: "transfer_not_sent",
          tenant_id: written.tenant_id,
          meta: { creator_order_id: written.id, reject_reason: res.reason },
        });
      }
    }
  }

  if (written.source === "applicant" && written.status === "cancelled" && deps.releaseApplication) {
    const release = deps.releaseApplication;
    await safely(deps, () => release({ tenant_id: written.tenant_id, order_id: written.id }).then(() => undefined));
  }

  if (
    decision.trigger === "creator_accept" &&
    written.status === "in_progress" &&
    written.source === "booking" &&
    order.brief_id &&
    !order.application_id &&
    deps.hireFromBooking
  ) {
    const hire = deps.hireFromBooking;
    const brief_id = order.brief_id;
    try {
      await hire({ tenant_id: written.tenant_id, brief_id, order_id: written.id, human_member_id: written.human_member_id });
    } catch (e) {
      await deps
        .log({
          level: "error",
          source: "creator.order",
          code: "booking_link_failed",
          message: (e as Error).message.slice(0, 300),
          tenant_id: written.tenant_id,
          meta: { creator_order_id: written.id, brief_id },
        })
        .catch(() => {});
      const retry = deps.retryBookingLink;
      if (retry) await safely(deps, () => retry({ order_id: written.id, tenant_id: written.tenant_id }));
    }
  }

  if (decision.trigger === "no_show") {
    await safely(deps, () => deps.markMissedDeadline(written.human_member_id));
  }

  if (deadline) {
    await safely(deps, () =>
      deps.armDeadline({ order_id: written.id, tenant_id: written.tenant_id, deadline }),
    );
  }
  if (decision.money.some((m) => m.kind === "arm_payout_buffer") && written.payout_ready_at) {
    await safely(deps, () =>
      deps.armPayoutBuffer({
        order_id: written.id,
        tenant_id: written.tenant_id,
        payout_ready_at: written.payout_ready_at as string,
      }),
    );
  }

  const businessName = await deps
    .businessName(written.tenant_id)
    .catch(() => null);
  const repeatBooking = decision.notices.some((n) => n.event === "booking_request_received")
    ? await deps
        .priorCompletedWithCreator(written.tenant_id, written.human_member_id)
        .catch(() => false)
    : false;
  const refund = refundOutcome(moneyLog);
  const vars: CreatorNotifyVars = {
    ...baseVars(written, businessName),
    note: args.note ?? null,
    refund_cents: refund.reason ? null : (args.refund_amount_cents ?? refund.cents),
    reason: refund.reason,
    deadline_kind: deadline?.kind ?? null,
    deadline_at: deadline?.deadline_at ?? null,
    payout_waiting: payoutWaiting,
    payout_sent: decision.money.some((m) => m.kind === "transfer") ? (transferSent ? true : transferInFlight ? null : false) : null,
    repeat_booking: repeatBooking,
    order_source: written.source,
    extension:
      decision.trigger === "request_extension"
        ? "requested"
        : decision.trigger === "approve_extension"
          ? "approved"
          : decision.trigger === "decline_extension"
            ? "declined"
            : null,
    mediation:
      decision.trigger === "mediation_refund"
        ? "refund"
        : decision.trigger === "mediation_pay_part"
          ? "pay_part"
          : decision.trigger === "mediation_pay_full"
            ? "pay_full"
            : null,
    extension_from: order.due_at ?? null,
    extension_to: args.requested_due_at ?? order.extension_requested_due_at ?? null,
  };
  const dedupe_window = noticeDedupeWindow(decision.trigger, order, written, submittedVersion);
  for (const notice of decision.notices) {
    if (notice.only_if === "transfer_sent" && !transferSent) continue;
    await safely(deps, () =>
      notice.to === "both"
        ? deps.notify.notifyBothSides({
            event: notice.event,
            tenant_id: written.tenant_id,
            human_member_id: written.human_member_id,
            order_id: written.id,
            vars,
            dedupe_window,
          })
        : deps.notify.notify({
            recipient:
              notice.to === "creator"
                ? { kind: "creator", human_member_id: written.human_member_id }
                : { kind: "tenant", tenant_id: written.tenant_id },
            event: notice.event,
            order_id: written.id,
            vars,
            dedupe_window,
            ...(notice.event === "revision_requested" && revisionRound !== null
              ? {
                  dedupe_key: `cn:${written.id}:revision_requested:round${revisionRound}:${notice.to}:${
                    notice.to === "creator" ? written.human_member_id : written.tenant_id
                  }`,
                }
              : {}),
          }),
    );
  }

  const pageStaff = deps.alert;
  if (needsStaff && args.actor !== "staff" && pageStaff) {
    await safely(deps, () =>
      pageStaff({
        source: "creator-order",
        code: "creator_order_needs_staff",
        tenant_id: written.tenant_id,
        msg:
          `Creator order ${written.id}: ${decision.trigger} (${decision.from} to ${decision.to}) ran, ` +
          `but the money needs a person: ${staffReasons.join(", ") || "needs_staff_review"}. ` +
          "Settle it by hand in Stripe and the staff console.",
        email: { dedupeKey: `creator_order_needs_staff:${written.id}:${decision.trigger}` },
      }),
    );
  }

  const disputeOpened = moneyLog.some(
    (m) => m.effect.kind === "freeze_payout" && (m.result === "opened" || m.result === "already_open"),
  );
  if (disputeOpened && pageStaff) {
    await safely(deps, () =>
      pageStaff({
        source: "creator-order",
        code: "creator_dispute_opened",
        tenant_id: written.tenant_id,
        msg:
          `Creator order ${written.id}: the ${args.actor === "creator" ? "creator" : "business"} asked Zavi to step in ` +
          `(${decision.trigger}). The payout is frozen until staff resolve it in Admin, Creator mediation.`,
        email: { dedupeKey: `creator_dispute_opened:${written.id}` },
      }),
    );
  }

  return {
    ok: true,
    order: written,
    trigger: decision.trigger,
    from: decision.from,
    to: decision.to,
    deadline,
    money: moneyLog,
    needs_staff_review: needsStaff,
    payout_waiting: payoutWaiting,
    payout_sent: transferSent ? true : transferInFlight ? null : false,
  };
}

export function noticeDedupeWindow(
  trigger: string,
  before: Pick<CreatorOrderStateRow, "cancel_requested_at" | "due_at">,
  after: Pick<CreatorOrderStateRow, "cancel_requested_at">,
  submittedVersion: number | null,
): string | null {
  const at = (iso: string | null) => (iso ? String(new Date(iso).getTime()) : "none");
  switch (trigger) {
    case "submit":
      return submittedVersion !== null ? `v${submittedVersion}` : null;
    case "request_cancellation":
      return `req${at(after.cancel_requested_at)}`;
    case "cancel_declined":
    case "cancel_revoked":
      return `req${at(before.cancel_requested_at)}`;
    case "request_extension":
    case "approve_extension":
    case "decline_extension":
      return trigger;
    case "due_date_reached":
      return `${trigger}:${at(before.due_at)}`;
    default:
      return null;
  }
}

function checkArgs(
  decision: CreatorOrderTransitionDecision,
  order: CreatorOrderStateRow,
  args: ApplyCreatorOrderTransitionArgs,
  now: Date,
): ApplyCreatorOrderTransitionResult | null {
  if (decision.trigger === "open_dispute_in_buffer" && !canAskZaviAfterAutoAccept(order, now)) {
    return {
      ok: false,
      code: "illegal_transition",
      message:
        order.closed_reason === "auto_accepted"
          ? "The 10 days to ask Zavi to step in on this job have passed, or the payout was already sent."
          : order.closed_reason === "approved"
            ? "You approved this job yourself, so it cannot be taken to Zavi now."
            : "Only a job that was accepted automatically can be taken to Zavi after it closed.",
    };
  }

  if (decision.money.some((m) => m.kind === "freeze_payout") && !args.dispute) {
    return {
      ok: false,
      code: "missing_argument",
      message: "Opening a dispute needs who opened it and why.",
    };
  }

  if (decision.trigger === "mediation_pay_part") {
    const c = args.creator_amount_cents;
    const r = args.refund_amount_cents;
    if (!Number.isInteger(c) || (c as number) <= 0 || (c as number) > order.creator_payout_cents) {
      return {
        ok: false,
        code: "invalid_amount",
        message: `The creator's share has to be between 1 and ${order.creator_payout_cents} cents.`,
      };
    }
    if (!Number.isInteger(r) || (r as number) <= 0 || (r as number) > order.business_total_cents) {
      return {
        ok: false,
        code: "invalid_amount",
        message: `The refund has to be between 1 and ${order.business_total_cents} cents.`,
      };
    }
    if ((c as number) + (r as number) > order.business_total_cents) {
      return {
        ok: false,
        code: "invalid_amount",
        message: `The creator's share and the refund add up to ${(c as number) + (r as number)} cents, but the business paid ${order.business_total_cents}. Together they cannot be more than that.`,
      };
    }
  }

  if (decision.trigger === "request_extension" && !args.requested_due_at) {
    return {
      ok: false,
      code: "missing_argument",
      message: "An extension request has to say which new date is being asked for.",
    };
  }

  if (decision.trigger === "product_received" && (order.product_needed !== true || order.product_received_at)) {
    return {
      ok: false,
      code: "illegal_transition",
      message: order.product_needed === true
        ? "The product was already marked as received on this job."
        : "This job does not wait on a product, so there is nothing to mark as received.",
    };
  }

  if (
    (decision.trigger === "request_extension" || decision.trigger === "approve_extension") &&
    order.product_needed === true &&
    !order.product_received_at
  ) {
    return {
      ok: false,
      code: "illegal_transition",
      message: "The due date starts when the product arrives, so there is no date to extend yet.",
    };
  }

  if (decision.trigger === "request_extension" && order.extension_state !== null) {
    return {
      ok: false,
      code: "illegal_transition",
      message: "This job has already had its one extension request.",
    };
  }

  if (decision.trigger === "approve_extension" && !order.extension_requested_due_at) {
    return {
      ok: false,
      code: "missing_argument",
      message: "There is no extension request on this order to approve.",
    };
  }

  return null;
}

function buildPatch(
  decision: CreatorOrderTransitionDecision,
  order: CreatorOrderStateRow,
  args: ApplyCreatorOrderTransitionArgs,
  nowIso: string,
): CreatorOrderStatePatch {
  const patch: CreatorOrderStatePatch = {};

  if (decision.status_changed) patch.status = decision.to;
  if (decision.status_changed && decision.is_terminal) {
    patch.closed_reason = decision.closed_reason;
    patch.closed_at = nowIso;
  }

  const s = decision.sets;
  if (s.responded_at === "now" && !order.responded_at) patch.responded_at = nowIso;
  if (s.accepted_at === "now") patch.accepted_at = nowIso;
  if (s.cancel_requested_at === "now") patch.cancel_requested_at = nowIso;
  if (s.cancel_requested_at === "clear") patch.cancel_requested_at = null;
  if (s.status_before_cancel_request === "now") patch.status_before_cancel_request = order.status;
  if (s.status_before_cancel_request === "clear") patch.status_before_cancel_request = null;
  if (s.payout_status) patch.payout_status = s.payout_status;
  if (s.payout_ready_at === "now") patch.payout_ready_at = nowIso;
  if (s.payout_ready_at === "now_plus_buffer") patch.payout_ready_at = payoutBufferEnd(nowIso);
  if (s.extension_state === "clear") patch.extension_state = null;
  else if (s.extension_state) patch.extension_state = s.extension_state;
  if (s.due_at === "from_extension_request") patch.due_at = order.extension_requested_due_at;
  if (s.due_at === "job_start" && !(order.product_needed && s.product_received_at !== "now")) {
    patch.due_at = jobStartDueAt(order, nowIso, decision.trigger === "offer_started");
  }
  if (s.product_received_at === "now") patch.product_received_at = nowIso;

  if (decision.trigger === "request_extension") {
    patch.extension_requested_due_at = args.requested_due_at as string;
  }
  if (decision.trigger === "mediation_pay_part") {
    patch.payout_amount_cents = args.creator_amount_cents as number;
  }

  return patch;
}

const DAY_MS = 86_400_000;

function jobStartDueAt(order: CreatorOrderStateRow, nowIso: string, atPayment: boolean): string {
  const agreed = agreedDueAt(order.package_snapshot?.["terms"]);
  if (agreed && (atPayment || Date.parse(agreed) > Date.parse(nowIso))) return agreed;
  return new Date(Date.parse(nowIso) + deliveryDays(order) * DAY_MS).toISOString();
}

function deliveryDays(order: CreatorOrderStateRow): number {
  const d = order.package_snapshot?.["delivery_days"];
  return typeof d === "number" && Number.isInteger(d) && d > 0 ? d : 7;
}

async function creatorCountry(
  order: CreatorOrderStateRow,
  deps: CreatorOrderDeps,
): Promise<string> {
  const snap = order.package_snapshot;
  const cc = snap?.["creator_country_code"];
  if (typeof cc === "string" && /^[A-Z]{2}$/.test(cc)) return cc;
  await deps.log({
    level: "warn",
    source: "creator.order",
    code: "order_missing_creator_country",
    tenant_id: order.tenant_id,
    meta: { creator_order_id: order.id },
  });
  return "";
}

async function settleHireFor(
  deps: CreatorOrderDeps,
  tenant_id: string,
  order_id: string,
  outcome: "spent" | "released",
): Promise<void> {
  const settle = deps.settleHire;
  if (!settle) return;
  await safely(deps, async () => {
    const r = await settle(tenant_id, order_id, outcome);
    if (r.status === "unavailable") throw new Error(`creator hire settle (${outcome}) failed for order ${order_id}: ${r.error}`);
  });
}

async function settleHireOrThrow(deps: CreatorOrderDeps, tenant_id: string, order_id: string): Promise<void> {
  if (!deps.settleHire) return;
  const r = await deps.settleHire(tenant_id, order_id, "released");
  if (r.status === "unavailable") throw new Error(`creator hire release failed for order ${order_id}: ${r.error}; retry`);
}

async function safely(deps: CreatorOrderDeps, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    await deps
      .log({
        level: "warn",
        source: "creator.order",
        code: "side_effect_failed",
        message: (e as Error).message.slice(0, 300),
      })
      .catch(() => {});
  }
}

export const DEADLINE_TRIGGER: Record<string, CreatorOrderTrigger> = {
  accept: "accept_expired",
  offer_expiry: "checkout_abandoned",
  checkout_expiry: "checkout_abandoned",
  review: "review_auto_accept",
  due: "due_date_reached",
  no_show_grace: "no_show",
  cancel_response: "cancel_no_response",
};

function deadlineMoved(
  expected: { at: string | null; kind: string | null },
  order: { next_deadline_at?: string | null; next_deadline_kind?: string | null },
): boolean {
  if ((expected.kind ?? null) !== (order.next_deadline_kind ?? null)) return true;
  const a = expected.at ? Date.parse(expected.at) : null;
  const b = order.next_deadline_at ? Date.parse(order.next_deadline_at) : null;
  return a !== b;
}

export type FireDeadlineOutcome =
  | { acted: false; reason: "not_due" | "no_trigger" | "rejected" | "checkout_not_closed" }
  | { acted: true; trigger: CreatorOrderTrigger; result: ApplyCreatorOrderTransitionResult };

export async function fireCreatorOrderDeadline(
  order_id: string,
  deps: CreatorOrderDeps = realCreatorOrderDeps,
  claim: (id: string) => Promise<CreatorOrderStateRow | null> = claimOrderDeadline,
): Promise<FireDeadlineOutcome> {
  const row = await claim(order_id);
  if (!row) return { acted: false, reason: "not_due" };
  return fireClaimedCreatorOrderDeadline(row, deps);
}

export async function fireClaimedCreatorOrderDeadline(
  row: CreatorOrderStateRow,
  deps: CreatorOrderDeps = realCreatorOrderDeps,
  release: (id: string) => Promise<number> = releaseOrderDeadlineLease,
  library: CreatorLibraryPort = realCreatorLibraryPort,
  retireHireCards: (a: { tenant_id: string; order_id: string }) => Promise<number> = async (a) =>
    (await import("./hire-card")).retireCreatorHireCards(a),
): Promise<FireDeadlineOutcome> {
  const trigger = row.next_deadline_kind ? DEADLINE_TRIGGER[row.next_deadline_kind] : undefined;
  if (!trigger) {
    await release(row.id).catch(() => 0);
    return { acted: false, reason: "no_trigger" };
  }

  if (row.status === "checkout_pending") {
    const settled = deps.settleUnpaidCheckout ? await deps.settleUnpaidCheckout(row) : null;
    if (!settled || settled.action !== "close") {
      if (settled?.action === "wait") {
        await deps.writeOrder({
          tenant_id: row.tenant_id,
          order_id: row.id,
          expected_status: "checkout_pending",
          patch: { next_deadline_at: settled.until, next_deadline_kind: row.next_deadline_kind, lease_until: null },
        });
      } else {
        await release(row.id).catch(() => 0);
      }
      return { acted: false, reason: "checkout_not_closed" };
    }
  }

  const result = await applyCreatorOrderTransition(
    {
      tenant_id: row.tenant_id,
      order_id: row.id,
      trigger,
      actor: "system",
      expected_deadline: { at: row.next_deadline_at ?? null, kind: row.next_deadline_kind ?? null },
    },
    deps,
  );

  if (!result.ok) {
    if (result.code === "illegal_transition" || result.code === "conflict") {
      await release(row.id).catch(() => 0);
      return { acted: false, reason: "rejected" };
    }
  }

  if (trigger === "checkout_abandoned" && result.ok) {
    try {
      await retireHireCards({ tenant_id: row.tenant_id, order_id: row.id });
    } catch (e) {
      await deps
        .log({
          level: "warn",
          source: "creator.order",
          code: "hire_card_retire_failed",
          message: (e as Error).message.slice(0, 300),
          tenant_id: row.tenant_id,
          meta: { creator_order_id: row.id },
        })
        .catch(() => {});
    }
  }

  if (trigger === "review_auto_accept" && result.ok) {
    try {
      await library.createLibraryAssetOnApproval(row.tenant_id, row.id);
    } catch (e) {
      await deps
        .log({
          level: "warn",
          source: "creator.order",
          code: "auto_accept_library_failed",
          message: (e as Error).message.slice(0, 300),
          tenant_id: row.tenant_id,
          meta: { creator_order_id: row.id },
        })
        .catch(() => {});
    }
  }
  return { acted: true, trigger, result };
}
