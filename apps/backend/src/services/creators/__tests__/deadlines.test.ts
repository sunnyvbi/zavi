
import { describe, expect, it } from "vitest";
import {
  ACCEPT_WINDOW_HOURS,
  AGENT_HIRE_HOLD_MS,
  agentHirePendingDeadline,
  checkoutPendingDeadline,
  NO_SHOW_GRACE_DAYS,
  PAYOUT_BUFFER_DAYS,
  isReminderWindow,
  orderDeadline,
  orderDeadlineCopy,
  orderDeadlineForRow,
  payoutBufferEnd,
  windowReminders,
} from "../deadlines";
import { deadlineCopy, dueAfterAcceptText } from "../deadline-copy";
import { bookingDueAfterAccept, canAskZaviAfterAutoAccept } from "../deadlines";
import type { CreatorOrderSource, CreatorOrderStatus } from "../order-state";

const T0 = "2026-09-11T00:00:00.000Z";
const H = 3_600_000;
const D = 24 * H;

function plus(base: string, ms: number): string {
  return new Date(new Date(base).getTime() + ms).toISOString();
}

function d(
  status: CreatorOrderStatus,
  over: Partial<Parameters<typeof orderDeadline>[0]> = {},
) {
  return orderDeadline({
    status,
    source: "booking" as CreatorOrderSource,
    state_entered_at: T0,
    now: T0,
    ...over,
  });
}

describe("which window is ticking, per state", () => {
  it("awaiting_acceptance: 72h to accept (Q2)", () => {
    expect(d("awaiting_acceptance")).toEqual({ kind: "accept", deadline_at: plus(T0, 72 * H) });
  });

  it("submitted: 72h to review, measured from THIS submission (Q5)", () => {
    const second = plus(T0, 5 * D);
    expect(d("submitted", { state_entered_at: second })).toEqual({
      kind: "review",
      deadline_at: plus(second, 72 * H),
    });
  });

  it("cancel_requested: 72h for the creator to answer (Q36)", () => {
    expect(d("cancel_requested")).toEqual({
      kind: "cancel_response",
      deadline_at: plus(T0, 72 * H),
    });
  });

  it("checkout_pending: 72h for a custom offer (Q35), 25h for a booking or hire", () => {
    expect(d("checkout_pending", { source: "offer" })).toEqual({
      kind: "offer_expiry",
      deadline_at: plus(T0, 72 * H),
    });
    for (const source of ["booking", "applicant"] as const) {
      expect(d("checkout_pending", { source })).toEqual({
        kind: "checkout_expiry",
        deadline_at: plus(T0, 25 * H),
      });
    }
  });

  it("a NEW unpaid order: an offer closes when the OFFER expires, not 72h after it was accepted", () => {
    const sent = plus(T0, -60 * H);
    expect(
      checkoutPendingDeadline({ source: "offer", now: T0, offer_expires_at: plus(sent, 72 * H) }),
    ).toEqual({ kind: "offer_expiry", deadline_at: plus(T0, 12 * H) });
    expect(checkoutPendingDeadline({ source: "booking", now: T0 })).toEqual({
      kind: "checkout_expiry",
      deadline_at: plus(T0, 25 * H),
    });
    expect(checkoutPendingDeadline({ source: "applicant", now: T0 })).toEqual({
      kind: "checkout_expiry",
      deadline_at: plus(T0, 25 * H),
    });
  });

  it("an agent-initiated hire is held exactly 72h, the same window as the card and an offer", () => {
    expect(AGENT_HIRE_HOLD_MS).toBe(259_200_000);
    expect(agentHirePendingDeadline(T0)).toEqual({ kind: "checkout_expiry", deadline_at: plus(T0, 72 * H) });
    expect(agentHirePendingDeadline(new Date(T0))).toEqual({ kind: "checkout_expiry", deadline_at: plus(T0, 72 * H) });
    expect(() => agentHirePendingDeadline("not a date")).toThrow();
  });

  it("in_progress: `due` before the date, `no_show_grace` after it (Q7)", () => {
    const due = plus(T0, 10 * D);
    expect(d("in_progress", { due_at: due, now: plus(due, -1) })).toEqual({
      kind: "due",
      deadline_at: due,
    });
    expect(d("in_progress", { due_at: due, now: due })).toEqual({
      kind: "no_show_grace",
      deadline_at: plus(due, 3 * D),
    });
  });

  it("in_progress with a draft already in: no clock at all (Q7)", () => {
    const due = plus(T0, 10 * D);
    expect(d("in_progress", { due_at: due, now: plus(due, 30 * D), has_submission: true })).toBeNull();
  });

  it("in_progress with no agreed due date has no clock", () => {
    expect(d("in_progress", { due_at: null })).toBeNull();
  });

  it.each(["revision_requested", "in_dispute", "completed", "cancelled"] as CreatorOrderStatus[])(
    "%s has no deadline",
    (s) => {
      expect(d(s, { due_at: plus(T0, D) })).toBeNull();
    },
  );
});

describe("the exact instants a customer would notice", () => {
  it("the accept window is 72 hours, not 3 days of local time", () => {
    const r = d("awaiting_acceptance");
    expect(new Date(r!.deadline_at).getTime() - new Date(T0).getTime()).toBe(72 * H);
    expect(ACCEPT_WINDOW_HOURS).toBe(72);
  });

  it("no-show fires at due + 3 days and NOT at due + 2", () => {
    const due = plus(T0, 4 * D);
    const grace = d("in_progress", { due_at: due, now: due })!;
    expect(NO_SHOW_GRACE_DAYS).toBe(3);
    expect(grace.deadline_at).toBe(plus(due, 3 * D));
    expect(grace.deadline_at).not.toBe(plus(due, 2 * D));
    expect(new Date(grace.deadline_at).getTime() - new Date(due).getTime()).toBe(3 * D);
  });

  it("the auto-accept payout buffer is 10 days (Q25)", () => {
    expect(PAYOUT_BUFFER_DAYS).toBe(10);
    expect(payoutBufferEnd(T0)).toBe(plus(T0, 10 * D));
  });

  it("reminders land 24h and 60h into a 72h window, so 48h and 12h before it closes", () => {
    const w = d("awaiting_acceptance")!;
    expect(windowReminders(w)).toEqual([
      { at_hours: 24, fire_at: plus(T0, 24 * H) },
      { at_hours: 60, fire_at: plus(T0, 60 * H) },
    ]);
  });

  it("only the four 72h windows get reminders", () => {
    for (const k of ["accept", "review", "cancel_response", "offer_expiry"] as const) {
      expect(isReminderWindow(k)).toBe(true);
    }
    for (const k of ["due", "no_show_grace"] as const) {
      expect(isReminderWindow(k)).toBe(false);
      expect(windowReminders({ kind: k, deadline_at: T0 })).toEqual([]);
    }
  });
});

describe("invariant 5: both sides see the SAME deadline and the SAME consequence", () => {
  const WINDOWS: [CreatorOrderStatus, CreatorOrderSource, Record<string, unknown>][] = [
    ["awaiting_acceptance", "booking", {}],
    ["submitted", "booking", {}],
    ["cancel_requested", "booking", {}],
    ["checkout_pending", "offer", {}],
    ["in_progress", "booking", { due_at: plus(T0, 2 * D), now: T0 }],
    ["in_progress", "booking", { due_at: plus(T0, -1 * D), now: T0 }],
  ];

  it.each(WINDOWS)("%s (%s): same instant on both sides, each in its own words", (status, source, over) => {
    const input = { status, source, state_entered_at: T0, now: T0, ...over };
    const creatorSide = orderDeadlineCopy(input, { side: "creator", other_name: "Acme" });
    const businessSide = orderDeadlineCopy(input, { side: "business", other_name: "Maya" });
    expect(creatorSide).not.toBeNull();
    expect(businessSide!.kind).toBe(creatorSide!.kind);
    expect(businessSide!.deadline_at).toBe(creatorSide!.deadline_at);
    expect(businessSide!.deadline_text).toBe(creatorSide!.deadline_text);
    expect(creatorSide!.line.startsWith(`Deadline: ${creatorSide!.deadline_text}. `)).toBe(true);
    expect(businessSide!.line.startsWith(`Deadline: ${creatorSide!.deadline_text}. `)).toBe(true);
    expect(businessSide!.consequence_text).not.toBe(creatorSide!.consequence_text);
    expect(creatorSide!.consequence_text).toMatch(/\byour?\b/i);
    expect(businessSide!.consequence_text).toMatch(/\byour?\b/i);
    expect(creatorSide!.consequence_text).not.toMatch(/the creator/i);
    expect(businessSide!.consequence_text).not.toMatch(/the business/i);
  });

  it("the accept window reads 'If you don't accept' to the creator and names her to the business", () => {
    const at = "2026-10-04T16:40:00.000Z";
    const c = deadlineCopy("accept", at, { side: "creator", other_name: "Acme" });
    const b = deadlineCopy("accept", at, { side: "business", other_name: "Maya" });
    expect(c.line).toBe(
      "Deadline: 04 Oct 2026 at 16:40 UTC. If you don't accept by then, the booking is cancelled, the hold on Acme's card is released and nothing is charged.",
    );
    expect(b.line).toBe(
      "Deadline: 04 Oct 2026 at 16:40 UTC. If Maya doesn't accept by then, the booking is cancelled, the hold on your card is released and nothing is charged.",
    );
  });

  it("a missing name falls back to the other side's role, capitalised at the start", () => {
    const b = deadlineCopy("accept", T0, { side: "business" });
    expect(b.consequence_text.startsWith("If the creator doesn't accept")).toBe(true);
    const c = deadlineCopy("review", T0, { side: "creator", other_name: "  " });
    expect(c.consequence_text.startsWith("If the business doesn't approve")).toBe(true);
  });

  it("a booking not accepted yet reads as days after the accept on both sides", () => {
    expect(dueAfterAcceptText(7, { side: "business", other_name: "Maya" })).toBe("7 days after Maya accepts");
    expect(dueAfterAcceptText(7, { side: "creator", other_name: "Acme" })).toBe("7 days after you accept");
    expect(dueAfterAcceptText(1, { side: "creator" })).toBe("1 day after you accept");
  });

  it("the deadline the row stores is the deadline the copy renders", () => {
    const dl = d("awaiting_acceptance")!;
    const who = { side: "business", other_name: "Maya" } as const;
    const copy = orderDeadlineCopy(
      { status: "awaiting_acceptance", source: "booking", state_entered_at: T0, now: T0 },
      who,
    )!;
    expect(copy.deadline_at).toBe(dl.deadline_at);
    expect(copy.kind).toBe(dl.kind);
    expect(copy).toEqual(deadlineCopy(dl.kind, dl.deadline_at, who));
  });

  it("the consequence is rendered in UTC, so two countries read one clock", () => {
    const copy = deadlineCopy("accept", "2026-09-14T00:00:00.000Z", { side: "creator" });
    expect(copy.deadline_text).toContain("UTC");
    expect(copy.line).toContain(copy.consequence_text);
  });

  it("every consequence sentence is plain language with no dashes", () => {
    for (const k of ["accept", "review", "due", "no_show_grace", "cancel_response", "offer_expiry", "checkout_expiry"] as const) {
      for (const side of ["creator", "business"] as const) {
        const c = deadlineCopy(k, T0, { side });
        expect(c.consequence_text).not.toMatch(/[—–]|--/);
        expect(c.consequence_text.length).toBeGreaterThan(20);
      }
    }
  });
});

describe("orderDeadlineForRow maps stored columns onto the right anchor", () => {
  const row = {
    status: "submitted" as CreatorOrderStatus,
    source: "booking" as CreatorOrderSource,
    created_at: T0,
    due_at: plus(T0, 7 * D),
    cancel_requested_at: null,
    last_submission_at: plus(T0, 6 * D),
  };

  it("a review window runs from the latest submission, not from the order", () => {
    expect(orderDeadlineForRow(row, plus(T0, 6 * D))).toEqual({
      kind: "review",
      deadline_at: plus(row.last_submission_at!, 72 * H),
    });
  });

  it("a cancellation window runs from cancel_requested_at", () => {
    const asked = plus(T0, 3 * D);
    expect(
      orderDeadlineForRow(
        { ...row, status: "cancel_requested", cancel_requested_at: asked, last_submission_at: null },
        asked,
      ),
    ).toEqual({ kind: "cancel_response", deadline_at: plus(asked, 72 * H) });
  });

  it("a submission on file disables the no-show clock even in_progress", () => {
    expect(
      orderDeadlineForRow({ ...row, status: "in_progress" }, plus(T0, 30 * D)),
    ).toBeNull();
  });

  it("an unparseable date is refused rather than rendered as a bad clock", () => {
    expect(() => d("awaiting_acceptance", { state_entered_at: "not a date" })).toThrow(
      /not a valid date/,
    );
    expect(() => deadlineCopy("accept", "not a date", { side: "creator" })).toThrow(/not a valid date/);
  });
});

describe("Ask Zavi to step in after a job closed (Ravi 2026-09-27: 10 days after auto-approve)", () => {
  const closed = plus(T0, 5 * D);
  const auto = { status: "completed", closed_reason: "auto_accepted", closed_at: closed, payout_status: "ready" };

  it("an auto-accepted job inside its 10 days is allowed", () => {
    expect(canAskZaviAfterAutoAccept(auto, plus(closed, 9 * D))).toBe(true);
    expect(canAskZaviAfterAutoAccept({ ...auto, payout_status: "awaiting_payout_account" }, plus(closed, 1 * D))).toBe(true);
  });

  it("a job the business approved itself is refused", () => {
    expect(canAskZaviAfterAutoAccept({ ...auto, closed_reason: "approved" }, plus(closed, 1 * D))).toBe(false);
  });

  it("10 days after the auto-accept it is refused", () => {
    expect(canAskZaviAfterAutoAccept(auto, plus(closed, 10 * D))).toBe(false);
    expect(canAskZaviAfterAutoAccept(auto, plus(closed, 30 * D))).toBe(false);
  });

  it("once the payout is sent (or sending) it is refused, even inside the window", () => {
    for (const p of ["transferring", "transferred", "reversed"]) {
      expect(canAskZaviAfterAutoAccept({ ...auto, payout_status: p }, plus(closed, 1 * D))).toBe(false);
    }
  });

  it("an open job is not this door", () => {
    expect(canAskZaviAfterAutoAccept({ ...auto, status: "submitted" }, plus(closed, 1 * D))).toBe(false);
  });
});

describe("bookingDueAfterAccept (Ravi 2026-09-27: the package window starts when the creator accepts)", () => {
  const row = { source: "booking", status: "awaiting_acceptance", due_at: null, product_needed: false, package_snapshot: { delivery_days: 5 } };
  it("a booking waiting for the creator reads as days after the accept", () => {
    expect(bookingDueAfterAccept(row, { side: "business", other_name: "Maya" })).toBe("5 days after Maya accepts");
    expect(bookingDueAfterAccept(row, { side: "creator" })).toBe("5 days after you accept");
  });
  it("is null once a date exists, for offers and hires, and for a product job", () => {
    expect(bookingDueAfterAccept({ ...row, due_at: plus(T0, 5 * D) }, { side: "creator" })).toBeNull();
    expect(bookingDueAfterAccept({ ...row, source: "offer" }, { side: "creator" })).toBeNull();
    expect(bookingDueAfterAccept({ ...row, status: "in_progress" }, { side: "creator" })).toBeNull();
    expect(bookingDueAfterAccept({ ...row, product_needed: true }, { side: "creator" })).toBeNull();
  });
});
