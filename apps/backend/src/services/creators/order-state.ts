
import type { CreatorMoneyEventCause } from "./db";

export type CreatorOrderStatus =
  | "checkout_pending"
  | "awaiting_acceptance"
  | "in_progress"
  | "submitted"
  | "revision_requested"
  | "cancel_requested"
  | "in_dispute"
  | "completed"
  | "cancelled";

export type CreatorOrderClosedReason =
  | "approved"
  | "auto_accepted"
  | "mediation_pay_full"
  | "mediation_pay_part"
  | "checkout_abandoned"
  | "declined"
  | "expired"
  | "withdrawn"
  | "payment_failed"
  | "no_show"
  | "cancel_agreed"
  | "cancel_no_response"
  | "mediation_refund"
  | "creator_removed";

export type CreatorOrderSource = "booking" | "offer" | "applicant";

export type CreatorOrderActor = "business" | "creator" | "staff" | "system";

export type CreatorOrderTrigger =
  | "checkout_completed"
  | "offer_started"
  | "checkout_abandoned"
  | "hire_applicant"
  | "creator_accept"
  | "capture_failed"
  | "creator_pass"
  | "accept_expired"
  | "offer_expired"
  | "business_withdraw"
  | "creator_removed"
  | "submit"
  | "request_revision"
  | "product_received"
  | "due_date_reached"
  | "request_extension"
  | "approve_extension"
  | "decline_extension"
  | "approve"
  | "review_auto_accept"
  | "payout_buffer_elapsed"
  | "no_show"
  | "request_cancellation"
  | "cancel_agreed"
  | "cancel_declined"
  | "cancel_revoked"
  | "cancel_no_response"
  | "cancel_disputed"
  | "open_dispute"
  | "open_dispute_in_buffer"
  | "mediation_pay_full"
  | "mediation_pay_part"
  | "mediation_refund";

export const MAX_REVISION_ROUNDS = 2;

export function revisionsUsed(rounds: number, status: CreatorOrderStatus): number {
  if (rounds <= 0) return 0;
  return status === "revision_requested" ? rounds : rounds - 1;
}

export const TERMINAL_STATUSES: readonly CreatorOrderStatus[] = ["completed", "cancelled"];

export function isTerminalCreatorOrderStatus(s: CreatorOrderStatus): boolean {
  return TERMINAL_STATUSES.includes(s);
}

export function isNeverPaidOrder(o: { status: string; closed_reason?: string | null }): boolean {
  return o.status === "checkout_pending" || (o.status === "cancelled" && o.closed_reason === "checkout_abandoned");
}

export const PAID_ORDER_FILTER = "closed_reason.is.null,closed_reason.neq.checkout_abandoned";

export type CreatorMoneyEffect =
  | { kind: "capture"; cause: Extract<CreatorMoneyEventCause, "creator_accept" | "hire"> }
  | {
      kind: "cancel_hold";
      cause: Extract<
        CreatorMoneyEventCause,
        "decline" | "expiry" | "withdrawn" | "checkout_abandoned" | "payment_failed" | "creator_removed"
      >;
    }
  | {
      kind: "transfer";
      cause: Extract<CreatorMoneyEventCause, "approval" | "auto_accept_buffer" | "mediation">;
      amount: "full" | "part";
    }
  | {
      kind: "refund";
      cause: Extract<
        CreatorMoneyEventCause,
        "no_show" | "cancel_agreed" | "cancel_no_response" | "mediation" | "creator_removed"
      >;
      amount: "full" | "remainder";
    }
  | { kind: "arm_payout_buffer" }
  | { kind: "freeze_payout" };

export type CreatorOrderFieldSets = {
  responded_at?: "now";
  accepted_at?: "now";
  cancel_requested_at?: "now" | "clear";
  status_before_cancel_request?: "now" | "clear";
  payout_status?: "ready" | "not_applicable";
  payout_ready_at?: "now" | "now_plus_buffer";
  extension_state?: "requested" | "approved" | "declined" | "clear";
  due_at?: "from_extension_request" | "job_start";
  product_received_at?: "now";
};

export type CreatorOrderNotice = {
  event: string;
  to: "both" | "creator" | "business";
  only_if?: "transfer_sent";
};

export type CreatorOrderTransition = {
  trigger: CreatorOrderTrigger;
  from: readonly CreatorOrderStatus[];
  to: CreatorOrderStatus | null;
  restores_status_before_cancel?: true;
  closed_reason?: CreatorOrderClosedReason;
  actors: readonly CreatorOrderActor[];
  sources?: readonly CreatorOrderSource[];
  requires_open_dispute?: readonly CreatorOrderStatus[];
  money: readonly CreatorMoneyEffect[];
  sets?: CreatorOrderFieldSets;
  notices: readonly CreatorOrderNotice[];
  spec: string;
};

const NO_MONEY: readonly CreatorMoneyEffect[] = [];

export const TRANSITIONS: readonly CreatorOrderTransition[] = [
  {
    trigger: "checkout_completed",
    from: ["checkout_pending"],
    to: "awaiting_acceptance",
    actors: ["system"],
    sources: ["booking"],
    money: NO_MONEY,
    notices: [{ event: "booking_request_received", to: "creator" }],
    spec: "Q2: a booking places a hold; the creator then has 72h to accept.",
  },
  {
    trigger: "offer_started",
    from: ["checkout_pending"],
    to: "in_progress",
    actors: ["system"],
    sources: ["offer"],
    money: [{ kind: "capture", cause: "hire" }],
    sets: { accepted_at: "now", responded_at: "now", due_at: "job_start" },
    notices: [{ event: "hired", to: "creator" }],
    spec: "Custom offer accepted by both sides: the hold is captured at once and the job starts, with no second 72h accept.",
  },
  {
    trigger: "checkout_abandoned",
    from: ["checkout_pending"],
    to: "cancelled",
    closed_reason: "checkout_abandoned",
    actors: ["system"],
    money: [{ kind: "cancel_hold", cause: "checkout_abandoned" }],
    sets: { payout_status: "not_applicable" },
    notices: [],
    spec: "Q2: an unfinished checkout never became a job; release anything Stripe holds.",
  },
  {
    trigger: "hire_applicant",
    from: ["checkout_pending"],
    to: "in_progress",
    actors: ["business"],
    sources: ["applicant"],
    money: [{ kind: "capture", cause: "hire" }],
    sets: { accepted_at: "now", responded_at: "now" },
    notices: [{ event: "hired", to: "creator" }],
    spec: "Q34: hiring an applicant charges the card at hire; the application converts to a job.",
  },
  {
    trigger: "creator_accept",
    from: ["awaiting_acceptance"],
    to: "in_progress",
    actors: ["creator"],
    money: [{ kind: "capture", cause: "creator_accept" }],
    sets: { accepted_at: "now", responded_at: "now", due_at: "job_start" },
    notices: [{ event: "creator_accepted", to: "business" }],
    spec: "Q2: capture when the creator accepts, and the delivery days start. Zavi holds the funds until approval.",
  },
  {
    trigger: "capture_failed",
    from: ["awaiting_acceptance", "checkout_pending"],
    to: "cancelled",
    closed_reason: "payment_failed",
    actors: ["system"],
    money: [{ kind: "cancel_hold", cause: "payment_failed" }],
    sets: { responded_at: "now", payout_status: "not_applicable" },
    notices: [{ event: "payment_failed", to: "both" }],
    spec: "T1: a capture failure cancels the job at once. No mark for the creator; both sides told why.",
  },
  {
    trigger: "creator_pass",
    from: ["awaiting_acceptance"],
    to: "cancelled",
    closed_reason: "declined",
    actors: ["creator"],
    money: [{ kind: "cancel_hold", cause: "decline" }],
    sets: { responded_at: "now", payout_status: "not_applicable" },
    notices: [{ event: "creator_passed", to: "business" }],
    spec: "Q2: creator passes, the hold is released, nothing is charged and no fee is lost.",
  },
  {
    trigger: "accept_expired",
    from: ["awaiting_acceptance"],
    to: "cancelled",
    closed_reason: "expired",
    actors: ["system"],
    money: [{ kind: "cancel_hold", cause: "expiry" }],
    sets: { payout_status: "not_applicable" },
    notices: [{ event: "cancellation_outcome", to: "both" }],
    spec: "Q2: no answer within 72h releases the hold.",
  },
  {
    trigger: "offer_expired",
    from: ["checkout_pending"],
    to: "cancelled",
    closed_reason: "expired",
    actors: ["system"],
    sources: ["offer"],
    money: [{ kind: "cancel_hold", cause: "expiry" }],
    sets: { payout_status: "not_applicable" },
    notices: [{ event: "cancellation_outcome", to: "both" }],
    spec: "Q35 + playback: a custom offer expires 72 hours after it is sent.",
  },
  {
    trigger: "business_withdraw",
    from: ["awaiting_acceptance"],
    to: "cancelled",
    closed_reason: "withdrawn",
    actors: ["business"],
    money: [{ kind: "cancel_hold", cause: "withdrawn" }],
    sets: { payout_status: "not_applicable" },
    notices: [{ event: "cancellation_outcome", to: "creator" }],
    spec: "Q36: before the creator accepts, the business can cancel at any time and the hold drops.",
  },
  {
    trigger: "creator_removed",
    from: ["checkout_pending", "awaiting_acceptance"],
    to: "cancelled",
    closed_reason: "creator_removed",
    actors: ["staff"],
    money: [{ kind: "cancel_hold", cause: "creator_removed" }],
    sets: { payout_status: "not_applicable" },
    notices: [{ event: "cancellation_outcome", to: "business" }],
    spec: "Q37: removal withdraws pending requests and drops their holds; in-progress jobs continue.",
  },

  {
    trigger: "submit",
    from: ["in_progress", "revision_requested"],
    to: "submitted",
    actors: ["creator"],
    money: NO_MONEY,
    notices: [{ event: "submission_received", to: "business" }],
    spec: "Q5: each submission opens the business's 72h review window.",
  },
  {
    trigger: "request_revision",
    from: ["submitted"],
    to: "revision_requested",
    actors: ["business"],
    money: NO_MONEY,
    notices: [{ event: "revision_requested", to: "creator" }],
    spec: "Q6: revisions are allowed while they align with the original order, up to 2 rounds. After that only approve or ask Zavi.",
  },
  {
    trigger: "product_received",
    from: ["in_progress"],
    to: null,
    actors: ["creator"],
    money: NO_MONEY,
    sets: { product_received_at: "now", due_at: "job_start" },
    notices: [{ event: "product_received", to: "business" }],
    spec: "Product needed: the delivery clock starts when the creator says the product arrived.",
  },
  {
    trigger: "due_date_reached",
    from: ["in_progress"],
    to: null,
    actors: ["system"],
    money: NO_MONEY,
    notices: [{ event: "due_date_nudge", to: "both" }],
    spec: "Q7: at the due date both sides are nudged. The 3 day grace then starts.",
  },
  {
    trigger: "request_extension",
    from: ["in_progress"],
    to: null,
    actors: ["creator"],
    money: NO_MONEY,
    sets: { extension_state: "requested" },
    notices: [{ event: "due_date_nudge", to: "business" }],
    spec: "Q7 + Q23: before the due date the creator may ask for ONE extension.",
  },
  {
    trigger: "approve_extension",
    from: ["in_progress"],
    to: null,
    actors: ["business"],
    money: NO_MONEY,
    sets: { extension_state: "approved", due_at: "from_extension_request" },
    notices: [{ event: "due_date_nudge", to: "creator" }],
    spec: "Q23: an approved extension moves the due date; the no-show clock follows it.",
  },
  {
    trigger: "decline_extension",
    from: ["in_progress"],
    to: null,
    actors: ["business"],
    money: NO_MONEY,
    sets: { extension_state: "declined" },
    notices: [{ event: "due_date_nudge", to: "creator" }],
    spec: "Q23: a declined extension leaves the agreed due date exactly where it was.",
  },

  {
    trigger: "approve",
    from: ["submitted"],
    to: "completed",
    closed_reason: "approved",
    actors: ["business"],
    money: [{ kind: "transfer", cause: "approval", amount: "full" }],
    sets: { payout_status: "ready", payout_ready_at: "now" },
    notices: [
      { event: "approved", to: "creator" },
      { event: "paid", to: "creator", only_if: "transfer_sent" },
    ],
    spec: "Q25: the business approves and the creator's payout is released instantly.",
  },
  {
    trigger: "review_auto_accept",
    from: ["submitted"],
    to: "completed",
    closed_reason: "auto_accepted",
    actors: ["system"],
    money: [{ kind: "arm_payout_buffer" }],
    sets: { payout_status: "ready", payout_ready_at: "now_plus_buffer" },
    notices: [{ event: "auto_accepted", to: "both" }],
    spec: "Q5 + Q25: no review within 72h auto-accepts; the payout follows 10 days later.",
  },
  {
    trigger: "payout_buffer_elapsed",
    from: ["completed"],
    to: null,
    actors: ["system"],
    money: [{ kind: "transfer", cause: "auto_accept_buffer", amount: "full" }],
    notices: [{ event: "paid", to: "creator", only_if: "transfer_sent" }],
    spec: "Q25: the 10 day buffer has passed with no dispute, so the payout is released.",
  },

  {
    trigger: "no_show",
    from: ["in_progress"],
    to: "cancelled",
    closed_reason: "no_show",
    actors: ["system"],
    money: [{ kind: "refund", cause: "no_show", amount: "full" }],
    sets: { payout_status: "not_applicable" },
    notices: [{ event: "cancellation_outcome", to: "both" }],
    spec: "Q7: no draft 3 days after the due date cancels the job, refunds in full and marks the creator.",
  },
  {
    trigger: "request_cancellation",
    from: ["in_progress", "submitted", "revision_requested"],
    to: "cancel_requested",
    actors: ["business"],
    money: NO_MONEY,
    sets: { cancel_requested_at: "now", status_before_cancel_request: "now" },
    notices: [{ event: "cancellation_requested", to: "creator" }],
    spec: "Q36: after accept the business REQUESTS cancellation; the creator has 72h to answer.",
  },
  {
    trigger: "cancel_agreed",
    from: ["cancel_requested"],
    to: "cancelled",
    closed_reason: "cancel_agreed",
    actors: ["creator"],
    money: [{ kind: "refund", cause: "cancel_agreed", amount: "full" }],
    sets: { payout_status: "not_applicable" },
    notices: [{ event: "cancellation_outcome", to: "both" }],
    spec: "Q36: the creator agrees, so the card is refunded in full INCLUDING the 10% Zavi fee.",
  },
  {
    trigger: "cancel_no_response",
    from: ["cancel_requested"],
    to: "cancelled",
    closed_reason: "cancel_no_response",
    actors: ["system"],
    money: [{ kind: "refund", cause: "cancel_no_response", amount: "full" }],
    sets: { payout_status: "not_applicable" },
    notices: [{ event: "cancellation_outcome", to: "both" }],
    spec: "Q36: 72h of silence counts as agreement; same full refund including the Zavi fee.",
  },
  {
    trigger: "cancel_declined",
    from: ["cancel_requested"],
    to: null,
    restores_status_before_cancel: true,
    actors: ["creator"],
    money: NO_MONEY,
    sets: { cancel_requested_at: "clear", status_before_cancel_request: "clear" },
    notices: [{ event: "cancellation_declined", to: "both" }],
    spec: "Q36 + Collabstr: the creator says no, the job carries on exactly where it was, and nothing is charged or refunded.",
  },
  {
    trigger: "cancel_revoked",
    from: ["cancel_requested"],
    to: null,
    restores_status_before_cancel: true,
    actors: ["business"],
    money: NO_MONEY,
    sets: { cancel_requested_at: "clear", status_before_cancel_request: "clear" },
    notices: [{ event: "cancellation_revoked", to: "both" }],
    spec: "Collabstr: 'if you revoke the request, the order will continue as normal.'",
  },
  {
    trigger: "cancel_disputed",
    from: ["cancel_requested"],
    to: "in_dispute",
    actors: ["creator"],
    money: [{ kind: "freeze_payout" }],
    sets: { status_before_cancel_request: "clear" },
    notices: [{ event: "dispute_opened", to: "both" }],
    spec: "Q36: the creator disputes the cancellation, so Zavi staff mediate and the money waits. Separate from cancel_declined: Collabstr treats declining and disputing as different things.",
  },
  {
    trigger: "open_dispute",
    from: ["in_progress", "submitted", "revision_requested", "cancel_requested"],
    to: "in_dispute",
    actors: ["business", "creator"],
    money: [{ kind: "freeze_payout" }],
    notices: [{ event: "dispute_opened", to: "both" }],
    spec: "Q6: either side can ask Zavi to step in. Money waits during mediation.",
  },
  {
    trigger: "open_dispute_in_buffer",
    from: ["completed"],
    to: null,
    actors: ["business"],
    money: [{ kind: "freeze_payout" }],
    notices: [{ event: "dispute_opened", to: "both" }],
    spec: "Q25: within 10 days of an auto-accept the business can still ask Zavi to step in; the payout waits.",
  },
  {
    trigger: "mediation_pay_full",
    from: ["in_dispute", "completed"],
    requires_open_dispute: ["completed"],
    to: "completed",
    closed_reason: "mediation_pay_full",
    actors: ["staff"],
    money: [{ kind: "transfer", cause: "mediation", amount: "full" }],
    sets: { payout_status: "ready", payout_ready_at: "now" },
    notices: [{ event: "dispute_resolved", to: "both" }],
    spec: "Q6: mediation outcome pay in full.",
  },
  {
    trigger: "mediation_pay_part",
    from: ["in_dispute", "completed"],
    requires_open_dispute: ["completed"],
    to: "completed",
    closed_reason: "mediation_pay_part",
    actors: ["staff"],
    money: [
      { kind: "refund", cause: "mediation", amount: "remainder" },
      { kind: "transfer", cause: "mediation", amount: "part" },
    ],
    sets: { payout_status: "ready", payout_ready_at: "now" },
    notices: [{ event: "dispute_resolved", to: "both" }],
    spec: "Q6: mediation outcome pay part. The creator gets payout_amount_cents, the business the rest.",
  },
  {
    trigger: "mediation_refund",
    from: ["in_dispute", "completed"],
    requires_open_dispute: ["completed"],
    to: "cancelled",
    closed_reason: "mediation_refund",
    actors: ["staff"],
    money: [{ kind: "refund", cause: "mediation", amount: "full" }],
    sets: { payout_status: "not_applicable" },
    notices: [{ event: "dispute_resolved", to: "both" }],
    spec: "Q6: mediation outcome refund.",
  },
];

const BY_TRIGGER = new Map<CreatorOrderTrigger, CreatorOrderTransition>(
  TRANSITIONS.map((t) => [t.trigger, t]),
);

if (BY_TRIGGER.size !== TRANSITIONS.length) {
  throw new Error("order-state: TRANSITIONS has a duplicate trigger.");
}

export type CreatorOrderTransitionRejection = {
  ok: false;
  code: "unknown_trigger" | "illegal_transition" | "wrong_actor" | "wrong_source";
  message: string;
};

export type CreatorOrderTransitionDecision = {
  ok: true;
  trigger: CreatorOrderTrigger;
  from: CreatorOrderStatus;
  to: CreatorOrderStatus;
  status_changed: boolean;
  closed_reason: CreatorOrderClosedReason | null;
  is_terminal: boolean;
  money: readonly CreatorMoneyEffect[];
  sets: CreatorOrderFieldSets;
  notices: readonly CreatorOrderNotice[];
  spec: string;
};

export type CreatorOrderTransitionResult =
  | CreatorOrderTransitionDecision
  | CreatorOrderTransitionRejection;

export function transitionCreatorOrder(input: {
  status: CreatorOrderStatus;
  source: CreatorOrderSource;
  trigger: CreatorOrderTrigger;
  actor?: CreatorOrderActor;
  has_open_dispute?: boolean;
  status_before_cancel_request?: CreatorOrderStatus | null;
}): CreatorOrderTransitionResult {
  const row = BY_TRIGGER.get(input.trigger);
  if (!row) {
    return {
      ok: false,
      code: "unknown_trigger",
      message: `'${String(input.trigger)}' is not a creator order trigger.`,
    };
  }

  if (!row.from.includes(input.status)) {
    return {
      ok: false,
      code: "illegal_transition",
      message: `'${row.trigger}' cannot run on an order that is ${input.status}. It is allowed from: ${row.from.join(", ")}.`,
    };
  }

  if (row.requires_open_dispute?.includes(input.status) && input.has_open_dispute !== true) {
    return {
      ok: false,
      code: "illegal_transition",
      message: `'${row.trigger}' can only run on a ${input.status} order that has an open dispute.`,
    };
  }

  if (row.sources && !row.sources.includes(input.source)) {
    return {
      ok: false,
      code: "wrong_source",
      message: `'${row.trigger}' only applies to a ${row.sources.join(" or ")} order, not a ${input.source} one.`,
    };
  }

  if (input.actor !== undefined && !row.actors.includes(input.actor)) {
    return {
      ok: false,
      code: "wrong_actor",
      message: `'${row.trigger}' cannot be triggered by the ${input.actor}. Allowed: ${row.actors.join(", ")}.`,
    };
  }

  const to = row.restores_status_before_cancel
    ? (input.status_before_cancel_request ?? "in_progress")
    : (row.to ?? input.status);
  return {
    ok: true,
    trigger: row.trigger,
    from: input.status,
    to,
    status_changed: to !== input.status,
    closed_reason: row.closed_reason ?? null,
    is_terminal: isTerminalCreatorOrderStatus(to),
    money: row.money,
    sets: row.sets ?? {},
    notices: row.notices,
    spec: row.spec,
  };
}

export function creatorOrderTriggersFrom(
  status: CreatorOrderStatus,
  source?: CreatorOrderSource,
  actor?: CreatorOrderActor,
  has_open_dispute = false,
): CreatorOrderTrigger[] {
  return TRANSITIONS.filter(
    (t) =>
      t.from.includes(status) &&
      (source === undefined || !t.sources || t.sources.includes(source)) &&
      (actor === undefined || t.actors.includes(actor)) &&
      (has_open_dispute || !t.requires_open_dispute?.includes(status)),
  ).map((t) => t.trigger);
}
