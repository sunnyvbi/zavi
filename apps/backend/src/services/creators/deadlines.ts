
import { deadlineCopy, dueAfterAcceptText, type DeadlineAudience, type DeadlineCopy, type DeadlineKind } from "./deadline-copy";
import type { CreatorOrderSource, CreatorOrderStatus } from "./order-state";

export const ACCEPT_WINDOW_HOURS = 72;
export const REVIEW_WINDOW_HOURS = 72;
export const CANCEL_RESPONSE_WINDOW_HOURS = 72;
export const OFFER_EXPIRY_HOURS = 72;
export const NO_SHOW_GRACE_DAYS = 3;
export const PAYOUT_BUFFER_DAYS = 10;
export const CHECKOUT_EXPIRY_HOURS = 25;
export const AGENT_HIRE_HOLD_MS = 72 * 60 * 60 * 1000;
export const REMINDER_HOURS_INTO_WINDOW = [24, 60] as const;

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

export const ACCEPT_WINDOW_MS = ACCEPT_WINDOW_HOURS * HOUR_MS;
export const REVIEW_WINDOW_MS = REVIEW_WINDOW_HOURS * HOUR_MS;
export const CANCEL_RESPONSE_WINDOW_MS = CANCEL_RESPONSE_WINDOW_HOURS * HOUR_MS;
export const OFFER_EXPIRY_MS = OFFER_EXPIRY_HOURS * HOUR_MS;
export const NO_SHOW_GRACE_MS = NO_SHOW_GRACE_DAYS * DAY_MS;
export const PAYOUT_BUFFER_MS = PAYOUT_BUFFER_DAYS * DAY_MS;
export const CHECKOUT_EXPIRY_MS = CHECKOUT_EXPIRY_HOURS * HOUR_MS;

export const REMINDER_WINDOWS: readonly DeadlineKind[] = [
  "accept",
  "review",
  "cancel_response",
  "offer_expiry",
];

export function isReminderWindow(kind: DeadlineKind): boolean {
  return REMINDER_WINDOWS.includes(kind);
}

export type CreatorOrderDeadline = {
  kind: DeadlineKind;
  deadline_at: string;
};

export type CreatorOrderDeadlineInput = {
  status: CreatorOrderStatus;
  source: CreatorOrderSource;
  state_entered_at: string | Date;
  due_at?: string | Date | null;
  has_submission?: boolean;
  now: string | Date;
};

function ms(v: string | Date, field: string): number {
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  if (Number.isNaN(t)) {
    throw new Error(`orderDeadline: ${field} '${String(v)}' is not a valid date.`);
  }
  return t;
}

function at(kind: DeadlineKind, epochMs: number): CreatorOrderDeadline {
  return { kind, deadline_at: new Date(epochMs).toISOString() };
}

export function orderDeadline(input: CreatorOrderDeadlineInput): CreatorOrderDeadline | null {
  const anchor = ms(input.state_entered_at, "state_entered_at");
  const now = ms(input.now, "now");

  switch (input.status) {
    case "checkout_pending":
      return input.source === "offer"
        ? at("offer_expiry", anchor + OFFER_EXPIRY_MS)
        : at("checkout_expiry", anchor + CHECKOUT_EXPIRY_MS);

    case "awaiting_acceptance":
      return at("accept", anchor + ACCEPT_WINDOW_MS);

    case "in_progress": {
      if (input.has_submission) return null;
      if (input.due_at === null || input.due_at === undefined) return null;
      const due = ms(input.due_at, "due_at");
      return now < due ? at("due", due) : at("no_show_grace", due + NO_SHOW_GRACE_MS);
    }

    case "submitted":
      return at("review", anchor + REVIEW_WINDOW_MS);

    case "cancel_requested":
      return at("cancel_response", anchor + CANCEL_RESPONSE_WINDOW_MS);

    case "revision_requested":
    case "in_dispute":
    case "completed":
    case "cancelled":
      return null;
  }
}

export function checkoutPendingDeadline(args: {
  source: CreatorOrderSource;
  now: string | Date;
  offer_expires_at?: string | null;
}): CreatorOrderDeadline {
  if (args.source === "offer" && args.offer_expires_at) {
    return at("offer_expiry", ms(args.offer_expires_at, "offer_expires_at"));
  }
  return at("checkout_expiry", ms(args.now, "now") + CHECKOUT_EXPIRY_MS);
}

export function agentHirePendingDeadline(now: string | Date): CreatorOrderDeadline {
  return at("checkout_expiry", ms(now, "now") + AGENT_HIRE_HOLD_MS);
}

export function agreedDueAt(terms: unknown): string | null {
  const d = terms && typeof terms === "object" ? (terms as Record<string, unknown>)["due_date"] : null;
  if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const t = Date.parse(`${d}T23:59:59.000Z`);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export function offerPayableUntil(expires_at: string, terms: unknown): string {
  const agreed = agreedDueAt(terms);
  return agreed && Date.parse(agreed) < Date.parse(expires_at) ? agreed : expires_at;
}

export function orderDeadlineCopy(
  input: CreatorOrderDeadlineInput,
  audience: DeadlineAudience,
): DeadlineCopy | null {
  const d = orderDeadline(input);
  return d ? deadlineCopy(d.kind, d.deadline_at, audience) : null;
}

export type CreatorOrderDeadlineRow = {
  status: CreatorOrderStatus;
  source: CreatorOrderSource;
  created_at: string;
  due_at: string | null;
  cancel_requested_at: string | null;
  last_submission_at?: string | null;
};

export function orderDeadlineForRow(
  row: CreatorOrderDeadlineRow,
  now: string | Date,
): CreatorOrderDeadline | null {
  const anchor =
    row.status === "submitted"
      ? (row.last_submission_at ?? row.created_at)
      : row.status === "cancel_requested"
        ? (row.cancel_requested_at ?? row.created_at)
        : row.created_at;

  return orderDeadline({
    status: row.status,
    source: row.source,
    state_entered_at: anchor,
    due_at: row.due_at,
    has_submission: row.last_submission_at != null,
    now,
  });
}

export function windowReminders(
  deadline: CreatorOrderDeadline,
): { at_hours: 24 | 60; fire_at: string }[] {
  if (!isReminderWindow(deadline.kind)) return [];
  const end = ms(deadline.deadline_at, "deadline_at");
  return REMINDER_HOURS_INTO_WINDOW.map((h) => ({
    at_hours: h,
    fire_at: new Date(end - (ACCEPT_WINDOW_HOURS - h) * HOUR_MS).toISOString(),
  }));
}

export function resumedAfterCancelHold(
  instant: string,
  cancel_requested_at: string,
  now: string | Date,
): string {
  const held = Math.max(0, ms(now, "now") - ms(cancel_requested_at, "cancel_requested_at"));
  return new Date(ms(instant, "instant") + held).toISOString();
}

export function payoutBufferEnd(auto_accepted_at: string | Date): string {
  return new Date(ms(auto_accepted_at, "auto_accepted_at") + PAYOUT_BUFFER_MS).toISOString();
}

const PAYOUT_MOVED = new Set(["transferring", "transferred", "reversed"]);

export function canAskZaviAfterAutoAccept(
  order: { status: string; closed_reason: string | null; closed_at: string | null; payout_status: string },
  now: string | Date,
): boolean {
  if (order.status !== "completed" || order.closed_reason !== "auto_accepted") return false;
  if (!order.closed_at || PAYOUT_MOVED.has(order.payout_status)) return false;
  return ms(now, "now") < ms(order.closed_at, "closed_at") + PAYOUT_BUFFER_MS;
}

export function firstWord(name: string | null | undefined): string | null {
  const w = (name ?? "").trim().split(/\s+/)[0];
  return w ? w : null;
}

export function bookingDueAfterAccept(
  row: { source: string; status: string; due_at: string | null; product_needed?: boolean | null; package_snapshot: Record<string, unknown> | null },
  audience: DeadlineAudience,
): string | null {
  if (row.source !== "booking" || row.due_at || row.product_needed === true) return null;
  if (row.status !== "awaiting_acceptance") return null;
  const d = row.package_snapshot?.["delivery_days"];
  const days = typeof d === "number" && Number.isInteger(d) && d > 0 ? d : 7;
  return dueAfterAcceptText(days, audience);
}

export { deadlineCopy, dueAfterAcceptText };
export type { DeadlineAudience, DeadlineCopy, DeadlineKind };
