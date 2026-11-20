
import { describe, expect, it, vi } from "vitest";
import {
  DEADLINE_TRIGGER,
  applyCreatorOrderTransition,
  fireClaimedCreatorOrderDeadline,
  fireCreatorOrderDeadline,
  type CreatorOrderDeps,
} from "../order-transitions";
import type { CreatorOrderStateRow } from "../orders-db";
import type { CreatorOrderStatus, CreatorOrderTrigger } from "../order-state";
import { windowReminders } from "../deadlines";

const TENANT = "11111111-1111-1111-1111-111111111111";
const ORDER = "22222222-2222-2222-2222-222222222222";
const CREATOR = "33333333-3333-3333-3333-333333333333";

const T0 = "2026-09-11T00:00:00.000Z";
const H = 3_600_000;
const D = 24 * H;
const plus = (base: string, ms: number) => new Date(new Date(base).getTime() + ms).toISOString();

function makeOrder(over: Partial<CreatorOrderStateRow> = {}): CreatorOrderStateRow {
  return {
    id: ORDER,
    tenant_id: TENANT,
    human_member_id: CREATOR,
    source: "booking",
    status: "awaiting_acceptance",
    closed_reason: null,
    created_at: T0,
    due_at: null,
    extension_requested_due_at: null,
    extension_state: null,
    next_deadline_at: plus(T0, 72 * H),
    next_deadline_kind: "accept",
    responded_at: null,
    accepted_at: null,
    cancel_requested_at: null,
    status_before_cancel_request: null,
    closed_at: null,
    payout_status: "not_due",
    payout_ready_at: null,
    payout_amount_cents: null,
    price_cents: 15_000,
    business_fee_cents: 1_500,
    creator_fee_cents: 2_250,
    business_total_cents: 16_500,
    creator_payout_cents: 12_750,
    package_snapshot: { title: "3 ad videos", creator_country_code: "US" },
    livemode: false,
    ...over,
  };
}

type Harness = {
  deps: CreatorOrderDeps;
  row: () => CreatorOrderStateRow;
  moneyCalls: string[];
  notices: {
    event: string;
    to: string;
    deadline_at: unknown;
    deadline_kind: unknown;
    repeat_booking: unknown;
    extension?: unknown;
    extension_from?: unknown;
    extension_to?: unknown;
  }[];
  repeatLookups: string[];
  armed: { order_id: string; deadline_at: string; kind: string }[];
  armedPayouts: { order_id: string; payout_ready_at: string }[];
  disputes: { opened: number; resolved: { outcome: string }[] };
  missedMarks: string[];
  setNow: (iso: string) => void;
};

function harness(
  initial: CreatorOrderStateRow,
  overrides: {
    capture?: unknown;
    transfer?: unknown;
    cancelHold?: unknown;
    refund?: unknown;
    submissionAt?: string | null;
    rounds?: number;
    now?: string;
    priorCompleted?: boolean;
    priorCompletedFails?: boolean;
  } = {},
): Harness {
  let order = { ...initial };
  let now = overrides.now ?? T0;
  const moneyCalls: string[] = [];
  const notices: Harness["notices"] = [];
  const repeatLookups: string[] = [];
  const armed: Harness["armed"] = [];
  const armedPayouts: Harness["armedPayouts"] = [];
  const disputes = { opened: 0, resolved: [] as { outcome: string }[] };
  const missedMarks: string[] = [];

  const deps: CreatorOrderDeps = {
    now: () => new Date(now),
    log: (async () => {}) as CreatorOrderDeps["log"],
    loadOrder: async (tid, oid) => (tid === order.tenant_id && oid === order.id ? { ...order } : null),
    writeOrder: async ({ expected_status, patch }) => {
      if (order.status !== expected_status) return null;
      order = { ...order, ...patch } as CreatorOrderStateRow;
      return { ...order };
    },
    latestSubmissionAt: async () => overrides.submissionAt ?? null,
    submissionRounds: async () => overrides.rounds ?? 0,
    openDispute: async () => {
      disputes.opened += 1;
      return disputes.opened === 1 ? "opened" : "already_open";
    },
    resolveDispute: async ({ outcome }) => {
      disputes.resolved.push({ outcome });
      return 1;
    },
    hasOpenDispute: async () => disputes.opened > 0,
    markMissedDeadline: async (id) => {
      missedMarks.push(id);
      return missedMarks.length;
    },
    money: {
      capture: (async (args: { cause: string }) => {
        moneyCalls.push(`capture:${args.cause}`);
        return (
          overrides.capture ?? {
            ok: true,
            payment_intent_id: "pi_1",
            charge_id: "ch_1",
            amount_cents: 16_500,
            already_captured: false,
          }
        );
      }) as unknown as CreatorOrderDeps["money"]["capture"],
      cancelHold: (async (args: { cause: string }) => {
        moneyCalls.push(`cancel_hold:${args.cause}`);
        return overrides.cancelHold ?? { ok: true, payment_intent_id: "pi_1", already_released: false };
      }) as unknown as CreatorOrderDeps["money"]["cancelHold"],
      transfer: (async (args: { cause: string }) => {
        moneyCalls.push(`transfer:${args.cause}`);
        return (
          overrides.transfer ?? {
            ok: true,
            transfer_id: "tr_1",
            amount_cents: 12_750,
            already_transferred: false,
            recorded: true,
          }
        );
      }) as unknown as CreatorOrderDeps["money"]["transfer"],
      refund: (async (args: { cause: string }) => {
        moneyCalls.push(`refund:${args.cause}`);
        return (
          overrides.refund ?? {
            refund_id: "re_1",
            refunded_cents: 16_500,
            already_refunded: false,
            reversed_cents: 0,
            reversal_shortfall_cents: 0,
            needs_staff_review: false,
          }
        );
      }) as unknown as CreatorOrderDeps["money"]["refund"],
    },
    notify: {
      notify: async ({ event, recipient, vars }) => {
        notices.push({
          event,
          to: recipient.kind,
          deadline_at: vars?.deadline_at ?? null,
          deadline_kind: vars?.deadline_kind ?? null,
          repeat_booking: vars?.repeat_booking ?? null,
          extension: vars?.extension ?? null,
          extension_from: vars?.extension_from ?? null,
          extension_to: vars?.extension_to ?? null,
        });
        return { written: true, emailed: true };
      },
      notifyBothSides: async ({ event, vars }) => {
        notices.push({
          event,
          to: "both",
          deadline_at: vars?.deadline_at ?? null,
          deadline_kind: vars?.deadline_kind ?? null,
          repeat_booking: vars?.repeat_booking ?? null,
          extension: vars?.extension ?? null,
        });
        return { creator: { written: true, emailed: true }, tenant: { written: true, emailed: true } };
      },
      sendWindowReminder: async () => ({ written: true, emailed: true }),
    },
    armDeadline: async ({ order_id, deadline }) => {
      armed.push({ order_id, deadline_at: deadline.deadline_at, kind: deadline.kind });
    },
    businessName: async () => "UpcarAI",
    priorCompletedWithCreator: async (tenant_id, human_member_id) => {
      repeatLookups.push(`${tenant_id}:${human_member_id}`);
      if (overrides.priorCompletedFails) throw new Error("history read blew up");
      return overrides.priorCompleted ?? false;
    },
    armPayoutBuffer: async ({ order_id, payout_ready_at }) => {
      armedPayouts.push({ order_id, payout_ready_at });
    },
  };

  return {
    deps,
    row: () => order,
    moneyCalls,
    notices,
    repeatLookups,
    armed,
    armedPayouts,
    disputes,
    missedMarks,
    setNow: (iso) => {
      now = iso;
    },
  };
}

function run(h: Harness, trigger: CreatorOrderTrigger, extra: Record<string, unknown> = {}) {
  return applyCreatorOrderTransition(
    { tenant_id: TENANT, order_id: ORDER, trigger, ...(trigger === "submit" ? { submission_version: 1 } : {}), ...extra },
    h.deps,
  );
}

describe("invariant 2: the money that moves, per trigger, end to end", () => {
  const CASES: [string, CreatorOrderStatus, CreatorOrderTrigger, Partial<CreatorOrderStateRow>, string[]][] = [
    ["creator accepts a booking", "awaiting_acceptance", "creator_accept", {}, ["capture:creator_accept"]],
    ["creator passes", "awaiting_acceptance", "creator_pass", {}, ["cancel_hold:decline"]],
    ["accept window expires", "awaiting_acceptance", "accept_expired", {}, ["cancel_hold:expiry"]],
    ["business withdraws before accept", "awaiting_acceptance", "business_withdraw", {}, ["cancel_hold:withdrawn"]],
    ["hiring an applicant", "checkout_pending", "hire_applicant", { source: "applicant" }, ["capture:hire"]],
    ["paying for an agreed custom offer", "checkout_pending", "offer_started", { source: "offer" }, ["capture:hire"]],
    ["a booking's checkout completes (hold only)", "checkout_pending", "checkout_completed", { source: "booking" }, []],
    ["the creator says the product arrived", "in_progress", "product_received", { product_needed: true }, []],
    ["business approves", "submitted", "approve", {}, ["transfer:approval"]],
    ["auto-accept at 72h", "submitted", "review_auto_accept", {}, []],
    ["the 10 day buffer ends", "completed", "payout_buffer_elapsed", { status: "completed", closed_reason: "auto_accepted", closed_at: T0, payout_status: "ready" }, ["transfer:auto_accept_buffer"]],
    ["no-show", "in_progress", "no_show", { due_at: plus(T0, -4 * D) }, ["refund:no_show"]],
    ["creator agrees to cancel", "cancel_requested", "cancel_agreed", { cancel_requested_at: T0 }, ["refund:cancel_agreed"]],
    ["creator says nothing for 72h", "cancel_requested", "cancel_no_response", { cancel_requested_at: T0 }, ["refund:cancel_no_response"]],
    ["mediation refunds", "in_dispute", "mediation_refund", {}, ["refund:mediation"]],
    ["mediation pays in full", "in_dispute", "mediation_pay_full", {}, ["transfer:mediation"]],
    ["submitting work", "in_progress", "submit", {}, []],
    ["asking for a revision", "submitted", "request_revision", {}, []],
    ["the due date nudge", "in_progress", "due_date_reached", { due_at: T0 }, []],
    ["approving an extension", "in_progress", "approve_extension", { due_at: plus(T0, D), extension_requested_due_at: plus(T0, 5 * D), extension_state: "requested" }, []],
    ["requesting cancellation", "in_progress", "request_cancellation", {}, []],
  ];

  it.each(CASES)("%s", async (_name, status, trigger, over, expected) => {
    const h = harness(makeOrder({ status, ...over }));
    const res = await run(h, trigger);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(h.moneyCalls).toEqual(expected);
  });

  it("an illegal trigger moves no money and changes no status", async () => {
    const h = harness(makeOrder({ status: "cancelled", closed_reason: "declined", closed_at: T0 }));
    const res = await run(h, "approve");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("illegal_transition");
    expect(h.moneyCalls).toEqual([]);
    expect(h.row().status).toBe("cancelled");
  });

  it("mediation pay-part refunds the business BEFORE paying the creator", async () => {
    const h = harness(makeOrder({ status: "in_dispute" }));
    const res = await run(h, "mediation_pay_part", {
      actor: "staff",
      creator_amount_cents: 6_000,
      refund_amount_cents: 8_000,
    });
    expect(res.ok).toBe(true);
    expect(h.moneyCalls).toEqual(["refund:mediation", "transfer:mediation"]);
    expect(h.row().payout_amount_cents).toBe(6_000);
    expect(h.disputes.resolved).toEqual([{ outcome: "pay_part" }]);
  });

  it("mediation pay-part is refused when the two shares add up to more than the business paid, and moves nothing", async () => {
    const h = harness(makeOrder({ status: "in_dispute" }));
    const res = await run(h, "mediation_pay_part", {
      actor: "staff",
      creator_amount_cents: 12_750,
      refund_amount_cents: 16_500,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("invalid_amount");
      expect(res.message).toContain("29250");
      expect(res.message).toContain("16500");
    }
    expect(h.moneyCalls).toEqual([]);
    expect(h.row().status).toBe("in_dispute");
    expect(h.disputes.resolved).toEqual([]);
  });

  it("mediation pay-part that uses exactly the whole charge still goes through", async () => {
    const h = harness(makeOrder({ status: "in_dispute" }));
    const res = await run(h, "mediation_pay_part", {
      actor: "staff",
      creator_amount_cents: 12_750,
      refund_amount_cents: 3_750,
    });
    expect(res.ok).toBe(true);
    expect(h.moneyCalls).toEqual(["refund:mediation", "transfer:mediation"]);
  });

  it("mediation pay-part is refused without both numbers, and moves nothing", async () => {
    for (const bad of [
      {},
      { creator_amount_cents: 6_000 },
      { refund_amount_cents: 8_000 },
      { creator_amount_cents: 99_999, refund_amount_cents: 8_000 },
      { creator_amount_cents: 6_000, refund_amount_cents: 99_999 },
      { creator_amount_cents: 0, refund_amount_cents: 1 },
    ]) {
      const h = harness(makeOrder({ status: "in_dispute" }));
      const res = await run(h, "mediation_pay_part", { actor: "staff", ...bad });
      expect(res.ok, JSON.stringify(bad)).toBe(false);
      expect(h.moneyCalls).toEqual([]);
    }
  });
});

describe("T1: a capture failure cancels the order immediately", () => {
  it("cancels, releases, never retries the capture", async () => {
    const h = harness(makeOrder(), {
      capture: {
        ok: false,
        action: "cancel_immediately",
        reason: "Your card was declined.",
        failure_code: "card_declined",
        funds_uncertain: false,
      },
    });
    const res = await run(h, "creator_accept", { actor: "creator" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.trigger).toBe("capture_failed");
    expect(h.row().status).toBe("cancelled");
    expect(h.row().closed_reason).toBe("payment_failed");
    expect(h.moneyCalls).toEqual(["capture:creator_accept", "cancel_hold:payment_failed"]);
    expect(h.notices.map((n) => n.event)).toContain("payment_failed");
  });
});

describe("stranded money is never papered over", () => {
  it("refuses to cancel an order whose hold turns out to be captured", async () => {
    const h = harness(makeOrder(), {
      cancelHold: { ok: false, action: "refund_required", payment_intent_id: "pi_1" },
    });
    const res = await run(h, "accept_expired", { actor: "system" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("money_needs_staff");
    expect(h.row().status).toBe("awaiting_acceptance");
    expect(h.row().closed_reason).toBeNull();
  });

  it("a short reversal still refunds the business, and flags staff", async () => {
    const h = harness(makeOrder({ status: "cancel_requested", cancel_requested_at: T0 }), {
      refund: {
        refund_id: "re_1",
        refunded_cents: 16_500,
        already_refunded: false,
        reversed_cents: 9_000,
        reversal_shortfall_cents: 3_750,
        needs_staff_review: true,
      },
    });
    const res = await run(h, "cancel_agreed", { actor: "creator" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.needs_staff_review).toBe(true);
    expect(h.row().status).toBe("cancelled");
  });
});

describe("Q25: auto-accept, then the 10 day buffer", () => {
  it("auto-accept closes the job, pays nobody, and arms the buffer 10 days out", async () => {
    const h = harness(makeOrder({ status: "submitted" }));
    const res = await run(h, "review_auto_accept", { actor: "system" });
    expect(res.ok).toBe(true);
    expect(h.moneyCalls).toEqual([]);
    const row = h.row();
    expect(row.status).toBe("completed");
    expect(row.closed_reason).toBe("auto_accepted");
    expect(row.payout_status).toBe("ready");
    expect(row.payout_ready_at).toBe(plus(T0, 10 * D));
    expect(h.armedPayouts).toEqual([{ order_id: ORDER, payout_ready_at: plus(T0, 10 * D) }]);
  });

  it("approval pays instantly instead, with no buffer", async () => {
    const h = harness(makeOrder({ status: "submitted" }));
    const res = await run(h, "approve", { actor: "business" });
    expect(res.ok).toBe(true);
    expect(h.moneyCalls).toEqual(["transfer:approval"]);
    expect(h.row().payout_ready_at).toBe(T0);
    expect(h.armedPayouts).toEqual([]);
  });

  it("the buffer transfer fires only once the order is completed and ready", async () => {
    const h = harness(
      makeOrder({
        status: "completed",
        closed_reason: "auto_accepted",
        closed_at: T0,
        payout_status: "ready",
        payout_ready_at: plus(T0, 10 * D),
      }),
    );
    h.setNow(plus(T0, 10 * D));
    const res = await run(h, "payout_buffer_elapsed", { actor: "system" });
    expect(res.ok).toBe(true);
    expect(h.moneyCalls).toEqual(["transfer:auto_accept_buffer"]);
  });
});

describe("invariant 7 / Q3: a payout that cannot reach the creator WAITS, visibly", () => {
  it("parks the order on awaiting_payout_account and asks the creator to finish Stripe", async () => {
    const h = harness(makeOrder({ status: "submitted" }), {
      transfer: {
        ok: false,
        reason: "awaiting_payout_account",
        message: "This creator has not finished their Stripe setup yet.",
      },
    });
    const res = await run(h, "approve", { actor: "business" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.payout_waiting).toBe(true);
    expect(h.row().status).toBe("completed");
    expect(h.row().payout_status).toBe("awaiting_payout_account");
    expect(h.notices.map((n) => n.event)).toContain("payout_setup_needed");
  });

  it("an inactive transfers capability waits too, and never half-pays", async () => {
    const h = harness(makeOrder({ status: "submitted" }), {
      transfer: {
        ok: false,
        reason: "transfers_capability_inactive",
        message: "Stripe has not activated transfers for this creator yet.",
      },
    });
    const res = await run(h, "approve", { actor: "business" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.payout_waiting).toBe(true);
    expect(h.row().payout_status).toBe("awaiting_payout_account");
  });
});

describe("a 'paid' notice requires a transfer that actually sent", () => {
  const PARKED = [
    ["no Stripe account yet", "awaiting_payout_account"],
    ["transfers capability off", "transfers_capability_inactive"],
    ["another worker won the claim", "claim_lost"],
  ] as const;

  it.each(PARKED)("approve with %s sends approved but NOT paid", async (_why, reason) => {
    const h = harness(makeOrder({ status: "submitted" }), {
      transfer: { ok: false, reason, message: "The payout did not go out." },
    });
    const res = await run(h, "approve", { actor: "business" });
    expect(res.ok).toBe(true);
    const events = h.notices.map((n) => n.event);
    expect(events).toContain("approved");
    expect(events).not.toContain("paid");
  });

  it("approve with a transfer that sends tells the creator they were paid, exactly once", async () => {
    const h = harness(makeOrder({ status: "submitted" }));
    const res = await run(h, "approve", { actor: "business" });
    expect(res.ok).toBe(true);
    expect(h.moneyCalls).toEqual(["transfer:approval"]);
    const paid = h.notices.filter((n) => n.event === "paid");
    expect(paid).toHaveLength(1);
    expect(paid[0].to).toBe("creator");
  });

  it("the 10 day buffer elapsing does not claim payment when the payout parks", async () => {
    const parked = {
      status: "completed" as const,
      closed_reason: "auto_accepted" as const,
      closed_at: T0,
      payout_status: "ready" as const,
      payout_ready_at: plus(T0, 10 * D),
    };
    const waiting = harness(makeOrder(parked), {
      transfer: { ok: false, reason: "awaiting_payout_account", message: "Stripe setup unfinished." },
    });
    waiting.setNow(plus(T0, 10 * D));
    expect((await run(waiting, "payout_buffer_elapsed", { actor: "system" })).ok).toBe(true);
    expect(waiting.notices.map((n) => n.event)).not.toContain("paid");
    expect(waiting.notices.map((n) => n.event)).toContain("payout_setup_needed");

    const sent = harness(makeOrder(parked));
    sent.setNow(plus(T0, 10 * D));
    expect((await run(sent, "payout_buffer_elapsed", { actor: "system" })).ok).toBe(true);
    expect(sent.notices.filter((n) => n.event === "paid")).toHaveLength(1);
  });

  it("a replayed transfer that already sent still counts as paid", async () => {
    const h = harness(makeOrder({ status: "submitted" }), {
      transfer: {
        ok: true,
        transfer_id: "tr_1",
        amount_cents: 12_750,
        already_transferred: true,
        recorded: true,
      },
    });
    expect((await run(h, "approve", { actor: "business" })).ok).toBe(true);
    expect(h.notices.filter((n) => n.event === "paid")).toHaveLength(1);
  });
});

describe("Q6 / Q25: a dispute freezes the payout", () => {
  function raced(winner: Partial<CreatorOrderStateRow>, from: CreatorOrderStatus = "submitted") {
    const h = harness(makeOrder({ status: from }));
    const discarded: string[] = [];
    h.deps.openDispute = async () => {
      Object.assign(h.row(), winner);
      return "opened";
    };
    h.deps.discardDispute = async ({ order_id }) => {
      discarded.push(order_id);
      return 1;
    };
    const ask = () =>
      run(h, "open_dispute", {
        actor: "creator",
        dispute: { kind: "step_in", opened_by: "creator", reason: "Too many changes." },
      });
    return { h, discarded, ask };
  }

  it("a step-in that loses the race to Approve removes its freeze and lets the approved payout go", async () => {
    const { h, discarded, ask } = raced({ status: "completed", closed_reason: "approved", closed_at: T0, payout_status: "ready" });
    const res = await ask();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("conflict");
    expect(res.message).toContain("Zavi was not asked to step in");
    expect(discarded).toEqual([ORDER]);
    expect(h.moneyCalls).toEqual(["transfer:approval"]);
    expect(h.notices.filter((n) => n.event === "dispute_opened")).toEqual([]);
    expect(h.notices.filter((n) => n.event === "paid").map((n) => n.to)).toEqual(["creator"]);
  });

  it("keeps the freeze when the other side's step-in won, and pays nobody", async () => {
    const { h, discarded, ask } = raced({ status: "in_dispute" });
    const res = await ask();
    expect(res.ok).toBe(false);
    expect(discarded).toEqual([]);
    expect(h.moneyCalls).toEqual([]);
  });

  it("keeps the freeze and pages staff when an auto-accept won, since the business may rely on that freeze", async () => {
    const { h, discarded, ask } = raced({ status: "completed", closed_reason: "auto_accepted", closed_at: T0, payout_status: "ready" });
    const pages: string[] = [];
    h.deps.alert = (async (a: { code: string; msg: string }) => {
      pages.push(`${a.code}:${a.msg}`);
    }) as unknown as CreatorOrderDeps["alert"];
    await ask();
    expect(discarded).toEqual([]);
    expect(h.moneyCalls).toEqual([]);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatch(/^creator_dispute_opened:.*dispute row is kept/);
  });

  it("tells the user Zavi was asked when an auto-accept won and the freeze is kept", async () => {
    const { ask } = raced({ status: "completed", closed_reason: "auto_accepted", closed_at: T0, payout_status: "ready" });
    const res = await ask();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain("Zavi was still asked to step in");
    expect(res.message).not.toContain("Zavi was not asked");
  });

  it("writes the freeze again when the other side's step-in moved the order to in_dispute while the lost one was being removed", async () => {
    const { h, discarded, ask } = raced({ status: "revision_requested" });
    const openRows: string[] = [];
    let opens = 0;
    h.deps.openDispute = async ({ order_id }) => {
      opens += 1;
      if (opens === 1) Object.assign(h.row(), { status: "revision_requested" });
      openRows.push(order_id);
      return "opened";
    };
    h.deps.discardDispute = async ({ order_id }) => {
      discarded.push(order_id);
      openRows.length = 0;
      Object.assign(h.row(), { status: "in_dispute" });
      return 1;
    };
    const pages: string[] = [];
    h.deps.alert = (async (a: { code: string }) => {
      pages.push(a.code);
    }) as unknown as CreatorOrderDeps["alert"];
    await ask();
    expect(discarded).toEqual([ORDER]);
    expect(h.row().status).toBe("in_dispute");
    expect(openRows).toEqual([ORDER]);
    expect(h.moneyCalls).toEqual([]);
    expect(pages).toEqual(["creator_dispute_opened"]);
  });

  it.each([
    ["a cancel request", { status: "cancel_requested", cancel_requested_at: T0, status_before_cancel_request: "submitted" }, "submitted"],
    ["a delivery", { status: "submitted" }, "in_progress"],
    ["a change request", { status: "revision_requested" }, "submitted"],
  ] as const)("removes its freeze when the job only moved to %s, so the user told 'not asked' really can ask again", async (_label, winner, from) => {
    const { h, discarded, ask } = raced(winner as Partial<CreatorOrderStateRow>, from as CreatorOrderStatus);
    const pages: string[] = [];
    h.deps.alert = (async (a: { code: string }) => {
      pages.push(a.code);
    }) as unknown as CreatorOrderDeps["alert"];
    const res = await ask();
    expect(res.ok).toBe(false);
    expect(discarded).toEqual([ORDER]);
    expect(h.moneyCalls).toEqual([]);
    expect(pages).toEqual([]);
  });

  it("parks the retried payout when the creator has no payout account, instead of asking staff to send it by hand", async () => {
    const { h, discarded, ask } = raced({ status: "completed", closed_reason: "approved", closed_at: T0, payout_status: "ready" });
    const pages: string[] = [];
    h.deps.alert = (async (a: { code: string }) => {
      pages.push(a.code);
    }) as unknown as CreatorOrderDeps["alert"];
    h.deps.money.transfer = (async () => ({ ok: false, reason: "awaiting_payout_account", message: "no account" })) as unknown as CreatorOrderDeps["money"]["transfer"];
    await ask();
    expect(discarded).toEqual([ORDER]);
    expect(h.row().payout_status).toBe("awaiting_payout_account");
    expect(h.notices.map((n) => n.event)).toContain("payout_setup_needed");
    expect(pages).toEqual([]);
  });

  it("pages Zavi staff once when the creator asks Zavi to step in, with ids only", async () => {
    const h = harness(makeOrder({ status: "submitted" }));
    const pages: Array<{ code: string; msg: string; email?: { dedupeKey: string } }> = [];
    h.deps.alert = (async (a: { code: string; msg: string; email?: { dedupeKey: string } }) => {
      pages.push(a);
    }) as unknown as CreatorOrderDeps["alert"];
    const res = await run(h, "open_dispute", {
      actor: "creator",
      dispute: { kind: "step_in", opened_by: "creator", reason: "Too many changes." },
    });
    expect(res.ok).toBe(true);
    expect(pages).toHaveLength(1);
    expect(pages[0].code).toBe("creator_dispute_opened");
    expect(pages[0].msg).toContain(ORDER);
    expect(pages[0].msg).toContain("creator asked Zavi to step in");
    expect(pages[0].msg).not.toContain("Too many changes");
    expect(pages[0].email?.dedupeKey).toBe(`creator_dispute_opened:${ORDER}`);
  });

  it("pages staff when the ask reuses a freeze the other side already wrote", async () => {
    const h = harness(makeOrder({ status: "submitted" }));
    h.deps.openDispute = async () => "already_open";
    const pages: string[] = [];
    h.deps.alert = (async (a: { code: string }) => {
      pages.push(a.code);
    }) as unknown as CreatorOrderDeps["alert"];
    const res = await run(h, "open_dispute", {
      actor: "business",
      dispute: { kind: "step_in", opened_by: "tenant", reason: "Same time." },
    });
    expect(res.ok).toBe(true);
    expect(pages).toEqual(["creator_dispute_opened"]);
  });

  it("pages staff for a business ask in the 10 day buffer too", async () => {
    const h = harness(
      makeOrder({ status: "completed", closed_reason: "auto_accepted", closed_at: T0, payout_status: "ready", payout_ready_at: plus(T0, 10 * D) }),
    );
    const pages: string[] = [];
    h.deps.alert = (async (a: { code: string }) => {
      pages.push(a.code);
    }) as unknown as CreatorOrderDeps["alert"];
    await run(h, "open_dispute_in_buffer", {
      actor: "business",
      dispute: { kind: "step_in", opened_by: "tenant", reason: "Never delivered." },
    });
    expect(pages).toEqual(["creator_dispute_opened"]);
  });

  it("opening a dispute mid-job stops the job and writes the freeze row", async () => {
    const h = harness(makeOrder({ status: "submitted" }));
    const res = await run(h, "open_dispute", {
      actor: "business",
      dispute: { kind: "step_in", opened_by: "tenant", reason: "The videos do not match the brief." },
    });
    expect(res.ok).toBe(true);
    expect(h.row().status).toBe("in_dispute");
    expect(h.disputes.opened).toBe(1);
    expect(h.moneyCalls).toEqual([]);
  });

  it("a dispute during the 10 day buffer keeps the order completed and pays nobody", async () => {
    const h = harness(
      makeOrder({
        status: "completed",
        closed_reason: "auto_accepted",
        closed_at: T0,
        payout_status: "ready",
        payout_ready_at: plus(T0, 10 * D),
      }),
    );
    const res = await run(h, "open_dispute_in_buffer", {
      actor: "business",
      dispute: { kind: "step_in", opened_by: "tenant", reason: "Never delivered what we agreed." },
    });
    expect(res.ok).toBe(true);
    const row = h.row();
    expect(row.status).toBe("completed");
    expect(row.closed_reason).toBe("auto_accepted");
    expect(h.disputes.opened).toBe(1);
    expect(h.moneyCalls).toEqual([]);
  });

  describe("Ravi 2026-09-27: step in after close only within 10 days of an AUTO-accept, before payout", () => {
    const closed = (over: Partial<CreatorOrderStateRow> = {}) =>
      makeOrder({
        status: "completed",
        closed_reason: "auto_accepted",
        closed_at: T0,
        payout_status: "ready",
        payout_ready_at: plus(T0, 10 * D),
        ...over,
      });
    const ask = (h: ReturnType<typeof harness>) =>
      run(h, "open_dispute_in_buffer", {
        actor: "business",
        dispute: { kind: "step_in", opened_by: "tenant", reason: "Not what we agreed." },
      });

    it("an auto-accepted job inside the window is allowed", async () => {
      const h = harness(closed());
      h.setNow(plus(T0, 9 * D));
      expect((await ask(h)).ok).toBe(true);
      expect(h.disputes.opened).toBe(1);
    });

    it("a job the business approved itself is refused", async () => {
      const h = harness(closed({ closed_reason: "approved", payout_ready_at: T0 }));
      h.setNow(plus(T0, 1 * D));
      const res = await ask(h);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe("illegal_transition");
      expect(h.disputes.opened).toBe(0);
    });

    it("outside the 10 day window it is refused", async () => {
      const h = harness(closed());
      h.setNow(plus(T0, 10 * D));
      const res = await ask(h);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe("illegal_transition");
      expect(h.disputes.opened).toBe(0);
    });

    it("after the payout was transferred it is refused, even inside the window", async () => {
      const h = harness(closed({ payout_status: "transferred" }));
      h.setNow(plus(T0, 2 * D));
      const res = await ask(h);
      expect(res.ok).toBe(false);
      expect(h.disputes.opened).toBe(0);
      expect(h.moneyCalls).toEqual([]);
    });
  });

  it("opening a dispute without saying who and why is refused", async () => {
    const h = harness(makeOrder({ status: "submitted" }));
    const res = await run(h, "open_dispute", { actor: "business" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("missing_argument");
    expect(h.disputes.opened).toBe(0);
  });
});

describe("Q7: the due date, an extension, and the no-show", () => {
  it("the due nudge hands the order straight to the 3 day grace", async () => {
    const due = plus(T0, 5 * D);
    const h = harness(makeOrder({ status: "in_progress", due_at: due, accepted_at: T0 }));
    h.setNow(due);
    const res = await run(h, "due_date_reached", { actor: "system" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.deadline).toEqual({ kind: "no_show_grace", deadline_at: plus(due, 3 * D) });
    expect(h.row().next_deadline_kind).toBe("no_show_grace");
    expect(h.moneyCalls).toEqual([]);
  });

  it("an approved extension moves the due date AND the no-show clock", async () => {
    const due = plus(T0, 5 * D);
    const asked = plus(T0, 12 * D);
    const h = harness(
      makeOrder({
        status: "in_progress",
        due_at: due,
        extension_requested_due_at: asked,
        extension_state: "requested",
      }),
    );
    const res = await run(h, "approve_extension", { actor: "business" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(h.row().due_at).toBe(asked);
    expect(h.row().extension_state).toBe("approved");
    expect(res.deadline).toEqual({ kind: "due", deadline_at: asked });
  });

  it("a declined extension leaves the agreed date exactly where it was", async () => {
    const due = plus(T0, 5 * D);
    const h = harness(
      makeOrder({
        status: "in_progress",
        due_at: due,
        extension_requested_due_at: plus(T0, 12 * D),
        extension_state: "requested",
      }),
    );
    await run(h, "decline_extension", { actor: "business" });
    expect(h.row().due_at).toBe(due);
    expect(h.row().extension_state).toBe("declined");
  });

  it("no-show refunds in full and leaves a missed-deadline mark", async () => {
    const due = plus(T0, -4 * D);
    const h = harness(makeOrder({ status: "in_progress", due_at: due }));
    const res = await run(h, "no_show", { actor: "system" });
    expect(res.ok).toBe(true);
    expect(h.moneyCalls).toEqual(["refund:no_show"]);
    expect(h.row().status).toBe("cancelled");
    expect(h.row().closed_reason).toBe("no_show");
    expect(h.missedMarks).toEqual([CREATOR]);
  });

  it("no other trigger leaves a missed-deadline mark", async () => {
    for (const [status, trigger, over] of [
      ["awaiting_acceptance", "creator_pass", {}],
      ["cancel_requested", "cancel_no_response", { cancel_requested_at: T0 }],
      ["in_dispute", "mediation_refund", {}],
    ] as const) {
      const h = harness(makeOrder({ status, ...over }));
      await run(h, trigger);
      expect(h.missedMarks, `${trigger}`).toEqual([]);
    }
  });
});

describe("the creator asks Zavi to step in (creator job page)", () => {
  it("open_dispute from the creator writes the freeze row and moves to in_dispute, no money", async () => {
    const h = harness(makeOrder({ status: "in_progress", due_at: plus(T0, 5 * D) }));
    const res = await run(h, "open_dispute", {
      actor: "creator",
      dispute: { kind: "step_in", opened_by: "creator", opened_by_user_id: "u", reason: "They stopped answering." },
    });
    expect(res.ok).toBe(true);
    expect(h.row().status).toBe("in_dispute");
    expect(h.disputes.opened).toBe(1);
    expect(h.moneyCalls).toEqual([]);
  });

  it("cancel_disputed from the creator freezes, and the 72h silence refund can no longer fire", async () => {
    const h = harness(makeOrder({ status: "cancel_requested", cancel_requested_at: T0 }));
    const res = await run(h, "cancel_disputed", {
      actor: "creator",
      dispute: { kind: "cancel_dispute", opened_by: "creator", opened_by_user_id: "u", reason: "The work is done." },
    });
    expect(res.ok).toBe(true);
    expect(h.row().status).toBe("in_dispute");
    expect(h.disputes.opened).toBe(1);
    h.setNow(plus(T0, 72 * H));
    const late = await run(h, "cancel_no_response", { actor: "system" });
    expect(late.ok).toBe(false);
    expect(h.moneyCalls).toEqual([]);
    expect(h.row().status).toBe("in_dispute");
  });
});

describe("Q36: 72h of silence on a cancellation", () => {
  it("refunds the card in full, including the 10% Zavi fee", async () => {
    const h = harness(makeOrder({ status: "cancel_requested", cancel_requested_at: T0 }));
    h.setNow(plus(T0, 72 * H));
    const res = await run(h, "cancel_no_response", { actor: "system" });
    expect(res.ok).toBe(true);
    expect(h.moneyCalls).toEqual(["refund:cancel_no_response"]);
    expect(h.row().closed_reason).toBe("cancel_no_response");
  });

  it("the cancellation window is what the timer reads, at 72h", async () => {
    const h = harness(makeOrder({ status: "in_progress", due_at: plus(T0, 9 * D) }));
    const res = await run(h, "request_cancellation", { actor: "business" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.deadline).toEqual({ kind: "cancel_response", deadline_at: plus(T0, 72 * H) });
    expect(h.armed).toEqual([
      { order_id: ORDER, deadline_at: plus(T0, 72 * H), kind: "cancel_response" },
    ]);
  });
});

describe("invariant 5: one deadline object reaches both sides", () => {
  it("a two-sided notice carries the SAME deadline the order stores", async () => {
    const due = plus(T0, 5 * D);
    const h = harness(makeOrder({ status: "in_progress", due_at: due }));
    h.setNow(due);
    await run(h, "due_date_reached", { actor: "system" });

    const both = h.notices.filter((n) => n.to === "both");
    expect(both.length).toBeGreaterThan(0);
    for (const n of both) {
      expect(n.deadline_at).toBe(h.row().next_deadline_at);
      expect(n.deadline_kind).toBe(h.row().next_deadline_kind);
    }
  });

  it("a submission opens the review window and both sides are told the same close time", async () => {
    const submittedAt = plus(T0, 2 * D);
    const h = harness(makeOrder({ status: "in_progress", due_at: plus(T0, 3 * D) }), {
      submissionAt: submittedAt,
    });
    h.setNow(submittedAt);
    const res = await run(h, "submit", { actor: "creator" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.deadline).toEqual({ kind: "review", deadline_at: plus(submittedAt, 72 * H) });
    expect(h.armed.at(-1)).toEqual({
      order_id: ORDER,
      deadline_at: plus(submittedAt, 72 * H),
      kind: "review",
    });
  });
});

const noLibrary = { createLibraryAssetOnApproval: async () => ({ created: false }) };

describe("timers: claim, act on the ROW, and replay as a no-op", () => {
  it("every deadline kind maps to exactly one trigger", () => {
    expect(DEADLINE_TRIGGER).toEqual({
      accept: "accept_expired",
      offer_expiry: "checkout_abandoned",
      checkout_expiry: "checkout_abandoned",
      review: "review_auto_accept",
      due: "due_date_reached",
      no_show_grace: "no_show",
      cancel_response: "cancel_no_response",
    });
  });

  it("closes an unpaid booking or hire whose Stripe page expired, silently, with no Stripe money call beyond cancel_hold", async () => {
    for (const source of ["booking", "applicant"] as const) {
      const row = makeOrder({ source, status: "checkout_pending", next_deadline_kind: "checkout_expiry", next_deadline_at: plus(T0, 25 * H) });
      const h = harness(row);
      const settle = vi.fn(async () => ({ action: "close" as const }));
      const out = await fireClaimedCreatorOrderDeadline(row, { ...h.deps, settleUnpaidCheckout: settle }, async () => 1);
      expect(settle).toHaveBeenCalledTimes(1);
      expect(out.acted).toBe(true);
      if (out.acted) expect(out.trigger).toBe("checkout_abandoned");
      expect(h.row().status).toBe("cancelled");
      expect(h.row().closed_reason).toBe("checkout_abandoned");
      expect(h.row().next_deadline_at).toBeNull();
      expect(h.moneyCalls).toEqual(["cancel_hold:checkout_abandoned"]);
      expect(h.notices).toEqual([]);
    }
  });

  it("an expired unpaid OFFER closes the same way, never as offer_expired (no creator mark, no notice)", async () => {
    const row = makeOrder({ source: "offer", status: "checkout_pending", next_deadline_kind: "offer_expiry", next_deadline_at: plus(T0, 72 * H) });
    const h = harness(row);
    const out = await fireClaimedCreatorOrderDeadline(
      row,
      { ...h.deps, settleUnpaidCheckout: async () => ({ action: "close" }) },
      async () => 1,
    );
    expect(out.acted && out.trigger).toBe("checkout_abandoned");
    expect(h.row().closed_reason).toBe("checkout_abandoned");
    expect(h.notices).toEqual([]);
  });

  it("does NOT close an unpaid order the Stripe check says is paid, still open, or unreadable", async () => {
    const row = makeOrder({ status: "checkout_pending", next_deadline_kind: "checkout_expiry", next_deadline_at: plus(T0, 25 * H) });

    const paid = harness(row);
    const released: string[] = [];
    const a = await fireClaimedCreatorOrderDeadline(
      row,
      { ...paid.deps, settleUnpaidCheckout: async () => ({ action: "settled", state: "fulfilled" }) },
      async (id) => (released.push(id), 1),
    );
    expect(a).toEqual({ acted: false, reason: "checkout_not_closed" });
    expect(released).toEqual([ORDER]);
    expect(paid.row().status).toBe("checkout_pending");
    expect(paid.moneyCalls).toEqual([]);

    const open = harness(row);
    const until = plus(T0, 30 * H);
    const b = await fireClaimedCreatorOrderDeadline(
      row,
      { ...open.deps, settleUnpaidCheckout: async () => ({ action: "wait", until, reason: "session_open" }) },
      async () => 1,
    );
    expect(b).toEqual({ acted: false, reason: "checkout_not_closed" });
    expect(open.row()).toMatchObject({ status: "checkout_pending", next_deadline_at: until, next_deadline_kind: "checkout_expiry", lease_until: null });
    expect(open.moneyCalls).toEqual([]);

    const blind = harness(row);
    const c = await fireClaimedCreatorOrderDeadline(row, blind.deps, async () => 1);
    expect(c).toEqual({ acted: false, reason: "checkout_not_closed" });
    expect(blind.row().status).toBe("checkout_pending");
    expect(blind.moneyCalls).toEqual([]);
  });

  it("fires the trigger the CLAIMED ROW names, not the one the event carried", async () => {
    const due = plus(T0, -4 * D);
    const row = makeOrder({
      status: "in_progress",
      due_at: due,
      next_deadline_kind: "no_show_grace",
      next_deadline_at: plus(due, 3 * D),
    });
    const h = harness(row);
    const out = await fireClaimedCreatorOrderDeadline(row, h.deps, async () => 1);
    expect(out.acted).toBe(true);
    if (out.acted) expect(out.trigger).toBe("no_show");
    expect(h.moneyCalls).toEqual(["refund:no_show"]);
  });

  it("a replayed timer event changes nothing the first fire did not", async () => {
    const h = harness(makeOrder({ status: "submitted", next_deadline_kind: "review" }));
    const first = await fireClaimedCreatorOrderDeadline(h.row(), h.deps, async () => 1, noLibrary);
    expect(first.acted).toBe(true);
    const afterFirst = { ...h.row() };

    const second = await fireClaimedCreatorOrderDeadline(
      { ...afterFirst, next_deadline_kind: "review", next_deadline_at: plus(T0, 72 * H) },
      h.deps,
      async () => 1,
      noLibrary,
    );
    expect(second.acted).toBe(false);
    if (!second.acted) expect(second.reason).toBe("rejected");
    expect(h.moneyCalls).toEqual([]);
    expect(h.row()).toEqual(afterFirst);
  });

  it("an auto-accepted review lands the video in the Creators library", async () => {
    const h = harness(makeOrder({ status: "submitted", next_deadline_kind: "review" }));
    const library = { createLibraryAssetOnApproval: vi.fn(async () => ({ created: true })) };
    const out = await fireClaimedCreatorOrderDeadline(h.row(), h.deps, async () => 1, library);
    expect(out.acted).toBe(true);
    expect(library.createLibraryAssetOnApproval).toHaveBeenCalledWith(TENANT, ORDER);
  });

  it("a library failure never fails or undoes the auto-accept", async () => {
    const h = harness(makeOrder({ status: "submitted", next_deadline_kind: "review" }));
    const library = {
      createLibraryAssetOnApproval: vi.fn(async (): Promise<{ created: boolean }> => {
        throw new Error("storage down");
      }),
    };
    const out = await fireClaimedCreatorOrderDeadline(h.row(), h.deps, async () => 1, library);
    expect(out.acted).toBe(true);
    if (out.acted) expect(out.result.ok).toBe(true);
    expect(h.row().status).toBe("completed");
    expect(h.row().closed_reason).toBe("auto_accepted");
  });

  it("other deadline triggers never write a library row", async () => {
    const h = harness(
      makeOrder({ status: "awaiting_acceptance", next_deadline_kind: "accept" }),
    );
    const library = { createLibraryAssetOnApproval: vi.fn(async () => ({ created: true })) };
    const out = await fireClaimedCreatorOrderDeadline(h.row(), h.deps, async () => 1, library);
    expect(out.acted).toBe(true);
    expect(library.createLibraryAssetOnApproval).not.toHaveBeenCalled();
  });

  it("a replayed PAYOUT fires the transfer once and is refused the second time", async () => {
    const h = harness(
      makeOrder({
        status: "completed",
        closed_reason: "auto_accepted",
        closed_at: T0,
        payout_status: "ready",
        payout_ready_at: T0,
      }),
    );
    const a = await run(h, "payout_buffer_elapsed", { actor: "system" });
    const b = await run(h, "payout_buffer_elapsed", { actor: "system" });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(h.moneyCalls).toEqual(["transfer:auto_accept_buffer", "transfer:auto_accept_buffer"]);
  });

  it("a lost race writes nothing and reports a conflict", async () => {
    const h = harness(makeOrder({ status: "submitted" }));
    const realWrite = h.deps.writeOrder;
    let first = true;
    h.deps.writeOrder = (async (args: Parameters<typeof realWrite>[0]) => {
      if (first) {
        first = false;
        return null;
      }
      return realWrite(args);
    }) as typeof realWrite;

    const res = await run(h, "review_auto_accept", { actor: "system" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("conflict");
    expect(h.row().status).toBe("submitted");
  });

  it("an order from another workspace is not found", async () => {
    const h = harness(makeOrder());
    const res = await applyCreatorOrderTransition(
      {
        tenant_id: "99999999-9999-9999-9999-999999999999",
        order_id: ORDER,
        trigger: "creator_accept",
        actor: "creator",
      },
      h.deps,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("order_not_found");
    expect(h.moneyCalls).toEqual([]);
  });
});

describe("a notification failure never undoes settled money", () => {
  it("the payout stands even when every notification throws", async () => {
    const h = harness(makeOrder({ status: "submitted" }));
    h.deps.notify = {
      notify: vi.fn().mockRejectedValue(new Error("SendGrid is down")),
      notifyBothSides: vi.fn().mockRejectedValue(new Error("SendGrid is down")),
      sendWindowReminder: vi.fn().mockRejectedValue(new Error("SendGrid is down")),
    };
    const res = await run(h, "approve", { actor: "business" });
    expect(res.ok).toBe(true);
    expect(h.moneyCalls).toEqual(["transfer:approval"]);
    expect(h.row().status).toBe("completed");
  });
});

describe("a booking from a business the creator has already delivered for", () => {
  it("is flagged as repeat work on the booking alert", async () => {
    const h = harness(makeOrder({ status: "checkout_pending" }), { priorCompleted: true });
    const res = await run(h, "checkout_completed", { actor: "system" });
    expect(res.ok).toBe(true);
    const alert = h.notices.find((n) => n.event === "booking_request_received");
    expect(alert?.to).toBe("creator");
    expect(alert?.repeat_booking).toBe(true);
    expect(h.repeatLookups).toEqual([`${TENANT}:${CREATOR}`]);
  });

  it("is not flagged when there is no finished job behind it", async () => {
    const h = harness(makeOrder({ status: "checkout_pending" }), { priorCompleted: false });
    await run(h, "checkout_completed", { actor: "system" });
    const alert = h.notices.find((n) => n.event === "booking_request_received");
    expect(alert?.repeat_booking).toBe(false);
  });

  it("does not ask about history on a transition that sends no booking alert", async () => {
    const h = harness(makeOrder({ status: "submitted" }), { priorCompleted: true });
    await run(h, "approve", { actor: "business" });
    expect(h.repeatLookups).toEqual([]);
  });

  it("books anyway when the history read fails, reading as a first contact", async () => {
    const h = harness(makeOrder({ status: "checkout_pending" }), {
      priorCompleted: true,
      priorCompletedFails: true,
    });
    const res = await run(h, "checkout_completed", { actor: "system" });
    expect(res.ok).toBe(true);
    expect(h.row().status).toBe("awaiting_acceptance");
    const alert = h.notices.find((n) => n.event === "booking_request_received");
    expect(alert?.repeat_booking).toBe(false);
  });
});

describe("offer_started: a paid custom offer starts the job with exactly one capture", () => {
  it("captures once, lands in_progress, stamps accepted_at and tells the creator", async () => {
    const h = harness(
      makeOrder({ source: "offer", status: "checkout_pending", due_at: plus(T0, 7 * D), next_deadline_kind: "offer_expiry" }),
    );
    const r = await run(h, "offer_started", { actor: "system" });
    expect(r.ok && r.to).toBe("in_progress");
    expect(h.moneyCalls).toEqual(["capture:hire"]);
    expect(h.row().accepted_at).toBe(T0);
    expect(h.notices.map((n) => n.event)).toEqual(["hired"]);
    const again = await run(h, "offer_started", { actor: "system" });
    expect(again.ok).toBe(false);
    expect(h.moneyCalls).toEqual(["capture:hire"]);
  });

  it("is impossible for a booking or an applicant order, and moves no money", async () => {
    for (const source of ["booking", "applicant"] as const) {
      const h = harness(makeOrder({ source, status: "checkout_pending" }));
      const r = await run(h, "offer_started", { actor: "system" });
      expect(r).toMatchObject({ ok: false, code: "wrong_source" });
      expect(h.moneyCalls).toEqual([]);
      expect(h.row().status).toBe("checkout_pending");
    }
  });

  it("a failed capture cancels the offer order at once (T1) and releases the hold", async () => {
    const h = harness(makeOrder({ source: "offer", status: "checkout_pending" }), {
      capture: { ok: false, failure_code: "card_declined" },
    });
    const r = await run(h, "offer_started", { actor: "system" });
    expect(r.ok && r.to).toBe("cancelled");
    expect(h.moneyCalls).toEqual(["capture:hire", "cancel_hold:payment_failed"]);
  });

  it("checkout_completed no longer applies to an offer", async () => {
    const h = harness(makeOrder({ source: "offer", status: "checkout_pending" }));
    const r = await run(h, "checkout_completed", { actor: "system" });
    expect(r).toMatchObject({ ok: false, code: "wrong_source" });
  });
});

describe("revision limit: two rounds of changes, then only approve or ask Zavi", () => {
  it("allows the first and second change request", async () => {
    for (const rounds of [1, 2]) {
      const h = harness(makeOrder({ status: "submitted" }), { rounds });
      const r = await run(h, "request_revision", { actor: "business" });
      expect(r.ok && r.to).toBe("revision_requested");
    }
  });

  it("each round's change request is its own notice (round 2 is not deduped into round 1)", async () => {
    const keys: (string | null | undefined)[] = [];
    for (const rounds of [1, 2]) {
      const h = harness(makeOrder({ status: "submitted" }), { rounds });
      const notify = h.deps.notify.notify;
      h.deps.notify.notify = async (input) => {
        if (input.event === "revision_requested") keys.push(input.dedupe_key);
        return notify(input);
      };
      await run(h, "request_revision", { actor: "business", note: `round ${rounds}` });
    }
    expect(keys).toEqual([
      `cn:${ORDER}:revision_requested:round1:creator:${CREATOR}`,
      `cn:${ORDER}:revision_requested:round2:creator:${CREATOR}`,
    ]);
  });

  it("refuses the third with revision_limit_reached and changes nothing", async () => {
    const h = harness(makeOrder({ status: "submitted" }), { rounds: 3 });
    const r = await run(h, "request_revision", { actor: "business" });
    expect(r).toMatchObject({ ok: false, code: "revision_limit_reached" });
    expect(h.row().status).toBe("submitted");
    expect(h.notices).toEqual([]);
  });

  it("approve and ask-Zavi still work after the limit", async () => {
    const a = harness(makeOrder({ status: "submitted" }), { rounds: 3 });
    expect((await run(a, "approve", { actor: "business" })).ok).toBe(true);
    const b = harness(makeOrder({ status: "submitted" }), { rounds: 3 });
    const r = await run(b, "open_dispute", {
      actor: "business",
      dispute: { kind: "step_in", opened_by: "tenant", reason: "Still wrong" },
    });
    expect(r.ok && r.to).toBe("in_dispute");
  });
});

describe("product_needed: the delivery clock starts when the product arrives", () => {
  it("sets due_at = now + delivery days and product_received_at, and arms the due timer", async () => {
    const h = harness(
      makeOrder({
        status: "in_progress",
        due_at: null,
        next_deadline_at: null,
        next_deadline_kind: null,
        product_needed: true,
        product_received_at: null,
        package_snapshot: { title: "UGC", creator_country_code: "US", delivery_days: 5 },
      }),
      { now: plus(T0, 3 * D) },
    );
    const r = await run(h, "product_received", { actor: "creator" });
    expect(r.ok).toBe(true);
    expect(h.row().due_at).toBe(plus(T0, 8 * D));
    expect(h.row().product_received_at).toBe(plus(T0, 3 * D));
    expect(h.row().next_deadline_kind).toBe("due");
    expect(h.armed.map((a) => a.kind)).toEqual(["due"]);
    expect(h.notices.map((n) => `${n.event}:${n.to}`)).toEqual(["product_received:tenant"]);
    expect(h.moneyCalls).toEqual([]);
  });

  it("refuses a second press, so the due date can only be set once", async () => {
    const h = harness(
      makeOrder({ status: "in_progress", product_needed: true, product_received_at: T0, due_at: plus(T0, 7 * D) }),
    );
    const r = await run(h, "product_received", { actor: "creator" });
    expect(r).toMatchObject({ ok: false, code: "illegal_transition" });
    expect(h.row().due_at).toBe(plus(T0, 7 * D));
  });

  it("refuses a job that does not need a product, and the business cannot press it", async () => {
    const h = harness(makeOrder({ status: "in_progress", product_needed: false, due_at: plus(T0, 7 * D) }));
    expect(await run(h, "product_received", { actor: "creator" })).toMatchObject({
      ok: false,
      code: "illegal_transition",
    });
    const b = harness(makeOrder({ status: "in_progress", product_needed: true, due_at: null }));
    expect(await run(b, "product_received", { actor: "business" })).toMatchObject({
      ok: false,
      code: "wrong_actor",
    });
  });

  it("refuses an extension ask or approval while the product has not arrived, so no no-show clock starts", async () => {
    const c = harness(makeOrder({ status: "in_progress", product_needed: true, product_received_at: null, due_at: null }));
    expect(
      await run(c, "request_extension", { actor: "creator", requested_due_at: plus(T0, 5 * D) }),
    ).toMatchObject({ ok: false, code: "illegal_transition" });
    const b = harness(
      makeOrder({
        status: "in_progress",
        product_needed: true,
        product_received_at: null,
        due_at: null,
        extension_requested_due_at: plus(T0, 5 * D),
        extension_state: "requested",
      }),
    );
    expect(await run(b, "approve_extension", { actor: "business" })).toMatchObject({
      ok: false,
      code: "illegal_transition",
    });
    expect(b.row().due_at).toBeNull();
    expect(b.armed).toEqual([]);
    const after = harness(
      makeOrder({ status: "in_progress", product_needed: true, product_received_at: T0, due_at: plus(T0, 7 * D) }),
    );
    expect((await run(after, "request_extension", { actor: "creator", requested_due_at: plus(T0, 9 * D) })).ok).toBe(true);
  });

  it("a product_needed job with no due date arms no delivery clock when it starts", async () => {
    const h = harness(
      makeOrder({ source: "offer", status: "checkout_pending", due_at: null, product_needed: true }),
    );
    const r = await run(h, "offer_started", { actor: "system" });
    expect(r.ok && r.to).toBe("in_progress");
    expect(r.ok && r.deadline).toBeNull();
    expect(h.armed).toEqual([]);
  });
});

describe("repeatable events notify once per occurrence, and a replay sends nothing twice", () => {
  function withDedupe(h: Harness) {
    const seen = new Set<string>();
    const delivered: string[] = [];
    const deliver = (event: string, window: string | null | undefined, side: string) => {
      const key = `${event}:${window ?? "once"}:${side}`;
      if (seen.has(key)) return false;
      seen.add(key);
      delivered.push(`${event}@${side}`);
      return true;
    };
    h.deps.notify.notify = async ({ event, recipient, dedupe_key, dedupe_window }) => {
      const ok = dedupe_key ? deliver(dedupe_key, "custom", recipient.kind) : deliver(event, dedupe_window, recipient.kind);
      return { written: ok, emailed: ok };
    };
    h.deps.notify.notifyBothSides = async ({ event, dedupe_window }) => {
      const c = deliver(event, dedupe_window, "creator");
      const t = deliver(event, dedupe_window, "tenant");
      return { creator: { written: c, emailed: c }, tenant: { written: t, emailed: t } };
    };
    return delivered;
  }

  it("v1 and v2 each tell the business once; replaying v2 tells it nothing more", async () => {
    const h = harness(makeOrder({ status: "in_progress", due_at: plus(T0, 10 * D) }), { rounds: 1 });
    const delivered = withDedupe(h);

    expect((await run(h, "submit", { actor: "creator", submission_version: 1 })).ok).toBe(true);
    expect((await run(h, "request_revision", { actor: "business" })).ok).toBe(true);
    expect((await run(h, "submit", { actor: "creator", submission_version: 2 })).ok).toBe(true);
    expect(delivered.filter((d) => d === "submission_received@tenant")).toHaveLength(2);

    const replay = harness(makeOrder({ status: "revision_requested", due_at: plus(T0, 10 * D) }));
    replay.deps.notify = h.deps.notify;
    expect((await run(replay, "submit", { actor: "creator", submission_version: 2 })).ok).toBe(true);
    expect(delivered.filter((d) => d === "submission_received@tenant")).toHaveLength(2);
  });

  it("a submit that does not name its version is refused before anything changes", async () => {
    const h = harness(makeOrder({ status: "in_progress", due_at: plus(T0, 10 * D) }));
    const r = await applyCreatorOrderTransition(
      { tenant_id: TENANT, order_id: ORDER, trigger: "submit", actor: "creator" },
      h.deps,
    );
    expect(r).toMatchObject({ ok: false, code: "missing_argument" });
    expect(h.row().status).toBe("in_progress");
  });

  it("a second cancellation request reaches the creator (its silence cancels the job)", async () => {
    const h = harness(makeOrder({ status: "in_progress", due_at: plus(T0, 10 * D) }));
    const delivered = withDedupe(h);
    await run(h, "request_cancellation", { actor: "business" });
    await run(h, "cancel_declined", { actor: "creator" });
    h.setNow(plus(T0, D));
    await run(h, "request_cancellation", { actor: "business" });
    await run(h, "cancel_declined", { actor: "creator" });
    expect(delivered.filter((d) => d === "cancellation_requested@creator")).toHaveLength(2);
    expect(delivered.filter((d) => d.startsWith("cancellation_declined@"))).toHaveLength(4);
  });

  it("tells each side which extension step happened, with the old and the new date", async () => {
    const h = harness(makeOrder({ status: "in_progress", due_at: plus(T0, 3 * D) }));
    await run(h, "request_extension", { actor: "creator", requested_due_at: plus(T0, 5 * D) });
    expect(h.notices.at(-1)).toMatchObject({
      event: "due_date_nudge",
      to: "tenant",
      extension: "requested",
      extension_from: plus(T0, 3 * D),
      extension_to: plus(T0, 5 * D),
    });
    await run(h, "approve_extension", { actor: "business" });
    expect(h.notices.at(-1)).toMatchObject({ to: "creator", extension: "approved", extension_to: plus(T0, 5 * D) });
    const d = harness(makeOrder({ status: "in_progress", due_at: plus(T0, 3 * D) }));
    await run(d, "request_extension", { actor: "creator", requested_due_at: plus(T0, 5 * D) });
    await run(d, "decline_extension", { actor: "business" });
    expect(d.notices.at(-1)).toMatchObject({ to: "creator", extension: "declined", extension_from: plus(T0, 3 * D) });
    const plain = harness(makeOrder({ status: "in_progress", due_at: plus(T0, 3 * D) }));
    await run(plain, "due_date_reached", { actor: "system" });
    expect(plain.notices.at(-1)).toMatchObject({ extension: null });
  });

  it("an extension request does not swallow the due-date nudge to the business", async () => {
    const h = harness(makeOrder({ status: "in_progress", due_at: plus(T0, 3 * D) }));
    const delivered = withDedupe(h);
    await run(h, "request_extension", { actor: "creator", requested_due_at: plus(T0, 5 * D) });
    await run(h, "approve_extension", { actor: "business" });
    await run(h, "due_date_reached", { actor: "system" });
    expect(delivered.filter((d) => d === "due_date_nudge@tenant")).toHaveLength(2);
    expect(delivered.filter((d) => d === "due_date_nudge@creator")).toHaveLength(2);
  });
});

describe("a declined or revoked cancellation gives back the time that was left when it was asked", () => {
  const claimIfDue = (h: Harness, at: () => string) => async (id: string) => {
    const r = h.row();
    if (r.id !== id || !r.next_deadline_at) return null;
    return Date.parse(r.next_deadline_at) <= Date.parse(at()) ? { ...r } : null;
  };

  for (const [trigger, actor] of [
    ["cancel_declined", "creator"],
    ["cancel_revoked", "business"],
  ] as const) {
    it(`${trigger}: a submission 60h into review, held 40h, still has 12h of review and is not auto-accepted`, async () => {
      let clock = T0;
      const h = harness(
        makeOrder({ status: "submitted", due_at: plus(T0, -2 * D), accepted_at: plus(T0, -5 * D), next_deadline_at: plus(T0, 72 * H), next_deadline_kind: "review" }),
        { submissionAt: T0 },
      );
      const tick = (iso: string) => {
        clock = iso;
        h.setNow(iso);
      };
      tick(plus(T0, 60 * H));
      expect((await run(h, "request_cancellation", { actor: "business" })).ok).toBe(true);
      tick(plus(T0, 100 * H));
      expect((await run(h, trigger, { actor })).ok).toBe(true);

      expect(h.row().status).toBe("submitted");
      expect(h.row().next_deadline_kind).toBe("review");
      expect(h.row().next_deadline_at).toBe(plus(T0, 112 * H));
      expect(h.armed.at(-1)).toMatchObject({ deadline_at: plus(T0, 112 * H), kind: "review" });

      const claim = claimIfDue(h, () => clock);
      expect(await fireCreatorOrderDeadline(ORDER, h.deps, claim)).toEqual({ acted: false, reason: "not_due" });
      tick(plus(T0, 112 * H - 1));
      expect(await fireCreatorOrderDeadline(ORDER, h.deps, claim)).toEqual({ acted: false, reason: "not_due" });
      expect(h.row().status).toBe("submitted");
      expect(h.row().payout_ready_at).toBeNull();
      expect(h.moneyCalls).toEqual([]);

      tick(plus(T0, 112 * H));
      expect(await fireCreatorOrderDeadline(ORDER, h.deps, claim)).toMatchObject({ acted: true, trigger: "review_auto_accept" });
    });
  }

  it("in_progress in its no-show grace: the due date moves by the hold, so the 24h of grace left survive", async () => {
    let clock = T0;
    const due = plus(T0, 2 * D);
    const h = harness(makeOrder({ status: "in_progress", due_at: due, accepted_at: T0, next_deadline_at: plus(due, 3 * D), next_deadline_kind: "no_show_grace" }));
    const tick = (iso: string) => {
      clock = iso;
      h.setNow(iso);
    };
    tick(plus(due, 2 * D));
    expect((await run(h, "request_cancellation", { actor: "business" })).ok).toBe(true);
    tick(plus(due, 10 * D));
    expect((await run(h, "cancel_declined", { actor: "creator" })).ok).toBe(true);

    expect(h.row().status).toBe("in_progress");
    expect(h.row().due_at).toBe(plus(due, 8 * D));
    expect(h.row().next_deadline_kind).toBe("no_show_grace");
    expect(h.row().next_deadline_at).toBe(plus(clock, D));

    const claim = claimIfDue(h, () => clock);
    expect(await fireCreatorOrderDeadline(ORDER, h.deps, claim)).toEqual({ acted: false, reason: "not_due" });
    expect(h.row().status).toBe("in_progress");
    expect(h.moneyCalls).toEqual([]);
    expect(h.missedMarks).toEqual([]);
  });

  it("in_progress before its due date: the days left to the due date survive the hold", async () => {
    const h = harness(makeOrder({ status: "in_progress", due_at: plus(T0, 5 * D), accepted_at: T0, next_deadline_at: plus(T0, 5 * D), next_deadline_kind: "due" }));
    h.setNow(plus(T0, D));
    await run(h, "request_cancellation", { actor: "business" });
    h.setNow(plus(T0, 3 * D));
    await run(h, "cancel_revoked", { actor: "business" });
    expect(h.row().due_at).toBe(plus(T0, 7 * D));
    expect(h.row().next_deadline_kind).toBe("due");
    expect(h.row().next_deadline_at).toBe(plus(T0, 7 * D));
  });

  it("other transitions out of in_progress leave the due date alone", async () => {
    const h = harness(makeOrder({ status: "in_progress", due_at: plus(T0, 5 * D), accepted_at: T0, cancel_requested_at: plus(T0, -D) }));
    h.setNow(plus(T0, D));
    await run(h, "request_cancellation", { actor: "business" });
    expect(h.row().due_at).toBe(plus(T0, 5 * D));
  });
});

describe("a paid custom offer is due when the offer said", () => {
  const offerOrder = (terms: Record<string, unknown>, over: Partial<CreatorOrderStateRow> = {}) =>
    makeOrder({
      source: "offer",
      status: "checkout_pending",
      due_at: plus(T0, 20 * D),
      package_snapshot: { title: "1 UGC video", creator_country_code: "US", delivery_days: 15, terms },
      ...over,
    });

  it("an agreed calendar day is the due date, however late the business pays", async () => {
    const h = harness(offerOrder({ due_date: "2026-09-26" }), { now: plus(T0, 2 * D) });
    expect((await run(h, "offer_started", { actor: "system" })).ok).toBe(true);
    expect(h.row().due_at).toBe("2026-09-26T23:59:59.000Z");
  });

  it("an offer of N days counts them from payment, not from when checkout opened", async () => {
    const paidAt = plus(T0, 2 * D);
    const h = harness(offerOrder({}), { now: paidAt });
    await run(h, "offer_started", { actor: "system" });
    expect(h.row().due_at).toBe(plus(paidAt, 15 * D));
  });

  it("a payment authorised in time but captured just after midnight keeps the agreed day", async () => {
    const h = harness(offerOrder({ due_date: "2026-09-12" }), { now: "2026-09-13T00:00:02.000Z" });
    await run(h, "offer_started", { actor: "system" });
    expect(h.row().due_at).toBe("2026-09-12T23:59:59.000Z");
  });

  it("a product that arrives after the agreed day gives the job its delivery days, never starts overdue", async () => {
    const h = harness(offerOrder({ due_date: "2026-09-12" }, { due_at: null, product_needed: true }));
    await run(h, "offer_started", { actor: "system" });
    const arrived = plus(T0, 5 * D);
    h.setNow(arrived);
    await run(h, "product_received", { actor: "creator" });
    expect(h.row().due_at).toBe(plus(arrived, 15 * D));
  });

  it("one extension per job: a second ask is refused server-side", async () => {
    const h = harness(makeOrder({ status: "in_progress", due_at: plus(T0, 3 * D), extension_state: "declined" }));
    expect(
      await run(h, "request_extension", { actor: "creator", requested_due_at: plus(T0, 6 * D) }),
    ).toMatchObject({ ok: false, code: "illegal_transition" });
  });

  it("a product-needed offer keeps no due date until the product arrives, then uses the agreed day", async () => {
    const h = harness(offerOrder({ due_date: "2026-09-26" }, { due_at: null, product_needed: true }));
    await run(h, "offer_started", { actor: "system" });
    expect(h.row().due_at).toBeNull();
    h.setNow(plus(T0, 3 * D));
    await run(h, "product_received", { actor: "creator" });
    expect(h.row().due_at).toBe("2026-09-26T23:59:59.000Z");
  });
});

describe("Ravi 2026-09-27: a package booking's delivery days start when the creator accepts", () => {
  it("accept writes the due date from the accept instant, and the due clock starts", async () => {
    const h = harness(
      makeOrder({ due_at: null, package_snapshot: { title: "3 ad videos", creator_country_code: "US", delivery_days: 7 } }),
    );
    const acceptAt = plus(T0, 2 * D);
    h.setNow(acceptAt);
    const res = await run(h, "creator_accept", { actor: "creator" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(h.row().due_at).toBe(plus(acceptAt, 7 * D));
    expect(res.deadline).toEqual({ kind: "due", deadline_at: plus(acceptAt, 7 * D) });
    expect(h.row().next_deadline_kind).toBe("due");
  });

  it("a date written at booking on an older row is replaced by the accept's", async () => {
    const h = harness(
      makeOrder({ due_at: plus(T0, 7 * D), package_snapshot: { title: "x", creator_country_code: "US", delivery_days: 5 } }),
    );
    h.setNow(plus(T0, 3 * D));
    await run(h, "creator_accept", { actor: "creator" });
    expect(h.row().due_at).toBe(plus(T0, 8 * D));
  });

  it("a product-needed booking still has no date until the product arrives", async () => {
    const h = harness(makeOrder({ due_at: null, product_needed: true, product_received_at: null }));
    const res = await run(h, "creator_accept", { actor: "creator" });
    expect(res.ok).toBe(true);
    expect(h.row().due_at).toBeNull();
  });
});

describe("a timer never acts on a deadline that moved after it was claimed", () => {
  it("refuses, before any money moves, when an extension pushed the no-show deadline out", async () => {
    const due = "2026-09-20T00:00:00.000Z";
    const claimed = makeOrder({
      status: "in_progress",
      due_at: due,
      next_deadline_kind: "no_show_grace",
      next_deadline_at: "2026-09-23T00:00:00.000Z",
    });
    const h = harness({ ...claimed, next_deadline_at: "2026-09-30T00:00:00.000Z" });
    const out = await fireClaimedCreatorOrderDeadline(claimed, h.deps, async () => 1);
    expect(out.acted).toBe(false);
    expect(h.moneyCalls).toEqual([]);
    expect(h.row().status).toBe("in_progress");
  });

  it("refuses when the deadline changed kind", async () => {
    const claimed = makeOrder({
      status: "in_progress",
      next_deadline_kind: "no_show_grace",
      next_deadline_at: "2026-09-23T00:00:00.000Z",
    });
    const h = harness({ ...claimed, next_deadline_kind: "due" });
    const out = await fireClaimedCreatorOrderDeadline(claimed, h.deps, async () => 1);
    expect(out.acted).toBe(false);
    expect(h.moneyCalls).toEqual([]);
  });

  it("treats the same instant in a different format as unchanged", async () => {
    const due = "2026-09-20T00:00:00.000Z";
    const claimed = makeOrder({
      status: "in_progress",
      due_at: due,
      next_deadline_kind: "no_show_grace",
      next_deadline_at: "2026-09-23T00:00:00+00:00",
    });
    const h = harness({ ...claimed, next_deadline_at: "2026-09-23T00:00:00.000Z" });
    const out = await fireClaimedCreatorOrderDeadline(claimed, h.deps, async () => 1);
    expect(out.acted).toBe(true);
  });
});

describe("a package booked from a brief counts as the brief's hire once the creator accepts", () => {
  type Hired = { tenant_id: string; brief_id: string; order_id: string; human_member_id: string };
  const withHire = (h: Harness, fail = false) => {
    const hired: Hired[] = [];
    const deps = {
      ...h.deps,
      hireFromBooking: async (a: Hired) => {
        hired.push(a);
        if (fail) throw new Error("db down");
        return "app-1";
      },
    };
    return { deps, hired };
  };
  const accept = (deps: CreatorOrderDeps) =>
    applyCreatorOrderTransition({ tenant_id: TENANT, order_id: ORDER, trigger: "creator_accept", actor: "creator" }, deps);

  it("hires the creator's application on that brief after the capture lands", async () => {
    const h = harness(makeOrder({ source: "booking", status: "awaiting_acceptance", brief_id: "brief-1", application_id: null }));
    const { deps, hired } = withHire(h);
    const res = await accept(deps);
    expect(res.ok).toBe(true);
    expect(h.row().status).toBe("in_progress");
    expect(h.moneyCalls).toEqual(["capture:creator_accept"]);
    expect(hired).toEqual([{ tenant_id: TENANT, brief_id: "brief-1", order_id: ORDER, human_member_id: h.row().human_member_id }]);
  });

  it("does nothing when the capture fails: no hire, the brief stays open", async () => {
    const h = harness(makeOrder({ source: "booking", status: "awaiting_acceptance", brief_id: "brief-1", application_id: null }), {
      capture: { ok: false, action: "cancel_immediately", reason: "declined", failure_code: "card_declined", funds_uncertain: false },
    });
    const { deps, hired } = withHire(h);
    await accept(deps);
    expect(h.row().status).toBe("cancelled");
    expect(hired).toEqual([]);
  });

  it.each([
    ["a booking with no brief", { source: "booking" as const, brief_id: null, application_id: null }],
    ["a booking already tied to an application", { source: "booking" as const, brief_id: "brief-1", application_id: "app-9" }],
  ])("leaves %s alone", async (_name, over) => {
    const h = harness(makeOrder({ status: "awaiting_acceptance", ...over }));
    const { deps, hired } = withHire(h);
    await accept(deps);
    expect(h.row().status).toBe("in_progress");
    expect(hired).toEqual([]);
  });

  it("a failure hiring the application never undoes the accept or the capture", async () => {
    const h = harness(makeOrder({ source: "booking", status: "awaiting_acceptance", brief_id: "brief-1", application_id: null }));
    const { deps, hired } = withHire(h, true);
    const res = await accept(deps);
    expect(res.ok).toBe(true);
    expect(h.row().status).toBe("in_progress");
    expect(h.moneyCalls).toEqual(["capture:creator_accept"]);
    expect(hired).toHaveLength(1);
  });
});

describe("a paid booking whose brief link fails is logged and handed to a durable retry", () => {
  type Logged = Parameters<CreatorOrderDeps["log"]>[0];
  const setup = (opts: { hireFails: boolean; retryFails?: boolean }) => {
    const h = harness(makeOrder({ source: "booking", status: "awaiting_acceptance", brief_id: "brief-1", application_id: null }));
    const logged: Logged[] = [];
    const retries: { order_id: string; tenant_id: string }[] = [];
    const deps: CreatorOrderDeps = {
      ...h.deps,
      log: (async (e: Logged) => {
        logged.push(e);
      }) as CreatorOrderDeps["log"],
      hireFromBooking: async () => {
        if (opts.hireFails) throw new Error("brief_applications update timed out");
        return "app-1";
      },
      retryBookingLink: async (a) => {
        retries.push(a);
        if (opts.retryFails) throw new Error("inngest unreachable");
      },
    };
    return { h, deps, logged, retries };
  };
  const accept = (deps: CreatorOrderDeps) =>
    applyCreatorOrderTransition({ tenant_id: TENANT, order_id: ORDER, trigger: "creator_accept", actor: "creator" }, deps);

  it("logs an error with ids only and asks for a retry of the link, after the capture and the accept stand", async () => {
    const { h, deps, logged, retries } = setup({ hireFails: true });
    const res = await accept(deps);
    expect(res.ok).toBe(true);
    expect(h.row().status).toBe("in_progress");
    expect(h.moneyCalls).toEqual(["capture:creator_accept"]);
    expect(retries).toEqual([{ order_id: ORDER, tenant_id: TENANT }]);
    const failure = logged.find((e) => e.code === "booking_link_failed");
    expect(failure).toMatchObject({ level: "error", source: "creator.order", tenant_id: TENANT });
    expect(failure?.meta).toEqual({ creator_order_id: ORDER, brief_id: "brief-1" });
  });

  it("a retry request that fails too never undoes the accept, and is itself logged", async () => {
    const { h, deps, logged, retries } = setup({ hireFails: true, retryFails: true });
    const res = await accept(deps);
    expect(res.ok).toBe(true);
    expect(h.row().status).toBe("in_progress");
    expect(h.moneyCalls).toEqual(["capture:creator_accept"]);
    expect(retries).toHaveLength(1);
    expect(logged.map((e) => e.code)).toEqual(expect.arrayContaining(["booking_link_failed", "side_effect_failed"]));
  });

  it("a link that lands asks for no retry and logs no failure", async () => {
    const { deps, logged, retries } = setup({ hireFails: false });
    await accept(deps);
    expect(retries).toEqual([]);
    expect(logged.find((e) => e.code === "booking_link_failed")).toBeUndefined();
  });
});

describe("a cancelled brief hire hands the applicant back", () => {
  it("releases the application when the hire's capture fails", async () => {
    const h = harness(makeOrder({ source: "applicant", status: "checkout_pending" }), {
      capture: { ok: false, action: "cancel_immediately", reason: "declined", failure_code: "card_declined", funds_uncertain: false },
    });
    const released: string[] = [];
    const deps = { ...h.deps, releaseApplication: async (a: { order_id: string }) => (released.push(a.order_id), true) };
    const res = await applyCreatorOrderTransition(
      { tenant_id: TENANT, order_id: ORDER, trigger: "hire_applicant", actor: "business" },
      deps,
    );
    expect(res.ok).toBe(true);
    expect(h.row().status).toBe("cancelled");
    expect(released).toContain(ORDER);
  });

  it("does not touch the application of a direct booking", async () => {
    const h = harness(makeOrder({ source: "booking" }), {
      capture: { ok: false, action: "cancel_immediately", reason: "declined", failure_code: "card_declined", funds_uncertain: false },
    });
    const released: string[] = [];
    const deps = { ...h.deps, releaseApplication: async (a: { order_id: string }) => (released.push(a.order_id), true) };
    await applyCreatorOrderTransition({ tenant_id: TENANT, order_id: ORDER, trigger: "creator_accept", actor: "creator" }, deps);
    expect(h.row().status).toBe("cancelled");
    expect(released).toEqual([]);
  });

  it("a failing release never undoes the cancel", async () => {
    const h = harness(makeOrder({ source: "applicant", status: "checkout_pending" }), {
      capture: { ok: false, action: "cancel_immediately", reason: "declined", failure_code: "card_declined", funds_uncertain: false },
    });
    const deps = { ...h.deps, releaseApplication: async () => { throw new Error("db down"); } };
    const res = await applyCreatorOrderTransition(
      { tenant_id: TENANT, order_id: ORDER, trigger: "hire_applicant", actor: "business" },
      deps,
    );
    expect(res.ok).toBe(true);
    expect(h.row().status).toBe("cancelled");
  });
});

describe("a creator hire's budget reservation follows the money", () => {
  function withSettle(h: Harness, answer: unknown = { status: "spent", changed: true }) {
    const calls: string[] = [];
    h.deps.settleHire = (async (tid: string, oid: string, outcome: string) => {
      calls.push(`${tid}:${oid}:${outcome}`);
      return answer;
    }) as never;
    return calls;
  }

  it("a capture settles it spent", async () => {
    const h = harness(makeOrder());
    const calls = withSettle(h);
    const res = await run(h, "creator_accept", { actor: "creator" });
    expect(res.ok).toBe(true);
    expect(calls).toEqual([`${TENANT}:${ORDER}:spent`]);
  });

  it("a released hold (decline / expiry) settles it released (test 8)", async () => {
    const h = harness(makeOrder());
    const calls = withSettle(h, { status: "released", changed: true });
    const res = await run(h, "accept_expired", { actor: "system" });
    expect(res.ok).toBe(true);
    expect(calls).toEqual([`${TENANT}:${ORDER}:released`]);
  });

  it("a failed capture releases it, never spends it", async () => {
    const h = harness(makeOrder(), {
      capture: { ok: false, action: "cancel_immediately", reason: "declined", failure_code: "card_declined", funds_uncertain: false },
    });
    const calls = withSettle(h, { status: "released", changed: true });
    await run(h, "creator_accept", { actor: "creator" });
    expect(calls).toEqual([`${TENANT}:${ORDER}:released`]);
  });

  it("a hold that turns out captured is not released", async () => {
    const h = harness(makeOrder(), { cancelHold: { ok: false, action: "refund_required", payment_intent_id: "pi_1" } });
    const calls = withSettle(h);
    await run(h, "accept_expired", { actor: "system" });
    expect(calls).toEqual([]);
  });

  it("an order no agent hired (not_found) moves exactly as before", async () => {
    const plain = harness(makeOrder());
    const withRpc = harness(makeOrder());
    withSettle(withRpc, { status: "not_found" });
    const a = await run(plain, "creator_accept", { actor: "creator" });
    const b = await run(withRpc, "creator_accept", { actor: "creator" });
    expect(b.ok && b.to).toBe(a.ok && a.to);
    expect(withRpc.moneyCalls).toEqual(plain.moneyCalls);
    expect(withRpc.row().status).toBe(plain.row().status);
  });

  it("review F1: an unpaid Checkout closing whose release fails does not move, so the deadline lease retries it", async () => {
    const h = harness(makeOrder({ status: "checkout_pending" }), { cancelHold: { ok: true, payment_intent_id: null, already_released: true } });
    const calls = withSettle(h, { status: "unavailable", error: "db down" });
    await expect(run(h, "checkout_abandoned", { actor: "system" })).rejects.toThrow(/release failed/);
    expect(h.row().status).toBe("checkout_pending");
    withSettle(h, { status: "released", changed: true });
    const res = await run(h, "checkout_abandoned", { actor: "system" });
    expect(res.ok).toBe(true);
    expect(h.row().status).toBe("cancelled");
    expect(calls).toEqual([`${TENANT}:${ORDER}:released`]);
  });

  it("a settle that fails never fails the transition", async () => {
    const h = harness(makeOrder());
    h.deps.settleHire = (async () => { throw new Error("db down"); }) as never;
    const res = await run(h, "creator_accept", { actor: "creator" });
    expect(res.ok).toBe(true);
    expect(h.row().status).not.toBe("awaiting_acceptance");
  });
});

describe("the creator's 72h accept window starts when the booking is paid, not when checkout opened", () => {
  it("a checkout paid 20h after the order was created gives the creator a full 72h and a 24h reminder inside it", async () => {
    const paidAt = plus(T0, 20 * H);
    const h = harness(makeOrder({ status: "checkout_pending" }), { now: paidAt });
    const res = await run(h, "checkout_completed", { actor: "system" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(h.row().status).toBe("awaiting_acceptance");
    expect(res.deadline).toEqual({ kind: "accept", deadline_at: plus(T0, 92 * H) });
    expect(h.row().next_deadline_at).toBe(plus(T0, 92 * H));
    expect(h.row().next_deadline_kind).toBe("accept");
    expect(h.armed).toEqual([{ order_id: ORDER, deadline_at: plus(T0, 92 * H), kind: "accept" }]);
    const alert = h.notices.find((n) => n.event === "booking_request_received");
    expect(alert?.deadline_at).toBe(plus(T0, 92 * H));
    const reminders = windowReminders(res.deadline!);
    expect(reminders.find((r) => r.at_hours === 24)?.fire_at).toBe(plus(T0, 44 * H));
    expect(new Date(reminders[0].fire_at).getTime()).toBeGreaterThan(new Date(paidAt).getTime());
    expect(h.row().created_at).toBe(T0);
  });
});
