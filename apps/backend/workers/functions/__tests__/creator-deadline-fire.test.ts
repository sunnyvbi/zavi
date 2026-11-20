
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  send: vi.fn(async () => ({ ids: ["e1"] })),
  isFleetHalted: vi.fn(async () => false),
  logEvent: vi.fn(async () => {}),
  handlers: {} as Record<string, (ctx: unknown) => Promise<unknown>>,
  retire: vi.fn(async (_a: { tenant_id: string; order_id: string }) => 1),
}));

vi.mock("../../client", () => ({
  inngest: {
    createFunction: (c: { id: string }, _t: unknown, f: (ctx: unknown) => Promise<unknown>) => {
      m.handlers[c.id] = f;
      return { id: "stub" };
    },
    send: m.send,
  },
}));
vi.mock("@/services/agents/fleet-halt", () => ({ isFleetHalted: m.isFleetHalted }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: m.logEvent }));
vi.mock("@/services/creators/hire-card", () => ({ retireCreatorHireCards: m.retire }));

import {
  armCreatorDeadline,
  armCreatorPayoutBuffer,
  runCreatorDeadlineSweep,
  sendCreatorGraceNudge,
  sendCreatorWindowReminder,
  timerDeps,
} from "../creator-deadline-fire";
import { settleUnpaidCheckout, type SettleUnpaidCheckoutDeps } from "@/services/creators/checkout-expiry";
import type { CreatorOrderDeps } from "@/services/creators/order-transitions";
import type { CreatorOrderStateRow } from "@/services/creators/orders-db";

const TENANT = "11111111-1111-1111-1111-111111111111";
const CREATOR = "33333333-3333-3333-3333-333333333333";
const T0 = "2026-09-11T00:00:00.000Z";
const H = 3_600_000;
const plus = (base: string, ms: number) => new Date(new Date(base).getTime() + ms).toISOString();

function row(over: Partial<CreatorOrderStateRow> = {}): CreatorOrderStateRow {
  return {
    id: "22222222-2222-2222-2222-222222222222",
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

function fakeDeps(state: { orders: Record<string, CreatorOrderStateRow>; money: string[] }): CreatorOrderDeps {
  const ok = async () => ({ ok: true }) as never;
  return {
    now: () => new Date(plus(T0, 100 * H)),
    log: (async () => {}) as CreatorOrderDeps["log"],
    loadOrder: async (_t, id) => state.orders[id] ?? null,
    writeOrder: async ({ order_id, expected_status, patch }) => {
      const cur = state.orders[order_id];
      if (!cur || cur.status !== expected_status) return null;
      state.orders[order_id] = { ...cur, ...patch } as CreatorOrderStateRow;
      return state.orders[order_id];
    },
    latestSubmissionAt: async () => null,
    submissionRounds: async () => 0,
    openDispute: async () => "opened",
    resolveDispute: async () => 1,
    hasOpenDispute: async () => false,
    markMissedDeadline: async () => 1,
    money: {
      capture: (async () => {
        state.money.push("capture");
        return { ok: true, payment_intent_id: "pi", charge_id: "ch", amount_cents: 1, already_captured: false };
      }) as never,
      cancelHold: (async (a: { cause: string }) => {
        state.money.push(`cancel_hold:${a.cause}`);
        return { ok: true, payment_intent_id: "pi", already_released: false };
      }) as never,
      transfer: (async (a: { cause: string }) => {
        state.money.push(`transfer:${a.cause}`);
        return { ok: true, transfer_id: "tr", amount_cents: 12_750, already_transferred: false, recorded: true };
      }) as never,
      refund: (async (a: { cause: string }) => {
        state.money.push(`refund:${a.cause}`);
        return {
          refund_id: "re",
          refunded_cents: 16_500,
          already_refunded: false,
          reversed_cents: 0,
          reversal_shortfall_cents: 0,
          needs_staff_review: false,
        };
      }) as never,
    },
    notify: {
      notify: ok as never,
      notifyBothSides: (async () => ({ creator: null, tenant: null })) as never,
      sendWindowReminder: ok as never,
    },
    armDeadline: async () => {},
    businessName: async () => "UpcarAI",
    priorCompletedWithCreator: async () => false,
    armPayoutBuffer: async () => {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.isFleetHalted.mockResolvedValue(false);
});

describe("the hourly sweep", () => {
  it("acts on every claimed row, using the row's own deadline kind", async () => {
    const a = row({ id: "a", next_deadline_kind: "accept" });
    const b = row({
      id: "b",
      status: "cancel_requested",
      cancel_requested_at: T0,
      next_deadline_kind: "cancel_response",
      next_deadline_at: plus(T0, 72 * H),
    });
    const state = { orders: { a, b }, money: [] as string[] };
    const deps = fakeDeps(state);

    let page = 0;
    const out = await runCreatorDeadlineSweep({ info: () => {}, error: () => {} }, deps, {
      claimDue: async () => (page++ === 0 ? [a, b] : []),
      listDuePayouts: async () => [],
    });

    expect(out.claimed).toBe(2);
    expect(out.acted).toBe(2);
    expect(state.money).toEqual(["cancel_hold:expiry", "refund:cancel_no_response"]);
    expect(state.orders.a.status).toBe("cancelled");
    expect(state.orders.a.closed_reason).toBe("expired");
    expect(state.orders.b.closed_reason).toBe("cancel_no_response");
  });

  it("claims nothing and moves no money while the fleet is halted", async () => {
    m.isFleetHalted.mockResolvedValue(true);
    const state = { orders: {}, money: [] as string[] };
    const claimDue = vi.fn(async () => [row()]);
    const out = await runCreatorDeadlineSweep({ info: () => {}, error: () => {} }, fakeDeps(state), {
      claimDue,
      listDuePayouts: async () => [],
    });
    expect(claimDue).not.toHaveBeenCalled();
    expect(out).toEqual({ claimed: 0, acted: 0, skipped: 0, payouts_attempted: 0, payouts_sent: 0 });
    expect(state.money).toEqual([]);
  });

  it("a row the sweep cannot act on is counted skipped and does NOT stop the page", async () => {
    const dead = row({ id: "dead", status: "cancelled", closed_reason: "declined", closed_at: T0 });
    const live = row({ id: "live" });
    const state = { orders: { dead, live }, money: [] as string[] };
    let page = 0;
    const out = await runCreatorDeadlineSweep({ info: () => {}, error: () => {} }, fakeDeps(state), {
      claimDue: async () => (page++ === 0 ? [dead, live] : []),
      listDuePayouts: async () => [],
    });
    expect(out.skipped).toBe(1);
    expect(out.acted).toBe(1);
    expect(state.money).toEqual(["cancel_hold:expiry"]);
  });

  it("sweeps the 10 day payout buffer that a lost sleeper would have missed (Q25)", async () => {
    const ready = row({
      id: "ready",
      status: "completed",
      closed_reason: "auto_accepted",
      closed_at: T0,
      payout_status: "ready",
      payout_ready_at: plus(T0, 10 * 24 * H),
    });
    const state = { orders: { ready }, money: [] as string[] };
    const out = await runCreatorDeadlineSweep({ info: () => {}, error: () => {} }, fakeDeps(state), {
      claimDue: async () => [],
      listDuePayouts: async () => [{ id: "ready", tenant_id: TENANT, human_member_id: CREATOR }],
    });
    expect(out.payouts_attempted).toBe(1);
    expect(out.payouts_sent).toBe(1);
    expect(state.money).toEqual(["transfer:auto_accept_buffer"]);
    expect(state.orders.ready.closed_reason).toBe("auto_accepted");
  });

  it.each([
    ["another worker won the transfer claim", async () => ({ ok: false, reason: "claim_lost", message: "taken" })],
    [
      "the Stripe call threw",
      async () => {
        throw new Error("Stripe connection reset");
      },
    ],
    ["the creator has no Stripe account yet", async () => ({ ok: false, reason: "awaiting_payout_account", message: "waits" })],
    ["Stripe refused the transfer", async () => ({ ok: false, reason: "stripe_error", message: "declined" })],
  ])("does not count a payout as sent when %s", async (_label, transfer) => {
    const ready = row({
      id: "ready",
      status: "completed",
      closed_reason: "auto_accepted",
      closed_at: T0,
      payout_status: "ready",
      payout_ready_at: plus(T0, 10 * 24 * H),
    });
    const state = { orders: { ready }, money: [] as string[] };
    const deps = fakeDeps(state);
    deps.money.transfer = transfer as never;
    const out = await runCreatorDeadlineSweep({ info: () => {}, error: () => {} }, deps, {
      claimDue: async () => [],
      listDuePayouts: async () => [{ id: "ready", tenant_id: TENANT, human_member_id: CREATOR }],
    });
    expect(out.payouts_attempted).toBe(1);
    expect(out.payouts_sent).toBe(0);
  });

  it("picks up unpaid orders left behind before the close existed (the backfilled rows) and closes only what nobody can pay", async () => {
    const unpaid = (id: string, over: Partial<CreatorOrderStateRow>) =>
      row({ id, status: "checkout_pending", next_deadline_kind: "checkout_expiry", next_deadline_at: plus(T0, 25 * H), ...over });
    const testBooking = unpaid("test-booking", { livemode: false });
    const testOffer = unpaid("test-offer", { source: "offer", livemode: false, next_deadline_kind: "offer_expiry" });
    const liveExpired = unpaid("live-expired", { livemode: true });
    const livePaid = unpaid("live-paid", { livemode: true });
    const state = { orders: { "test-booking": testBooking, "test-offer": testOffer, "live-expired": liveExpired, "live-paid": livePaid }, money: [] as string[] };

    const fulfil = vi.fn(async ({ order_id }: { order_id: string }) =>
      order_id === "live-paid"
        ? ({ state: "fulfilled", order_id, status: "awaiting_acceptance", payment_intent_id: "pi", hold_expires_at: null } as const)
        : ({ state: "pending", order_id, reason: "no_payment_intent" } as const),
    );
    const settleDeps: SettleUnpaidCheckoutDeps = {
      fulfil: fulfil as unknown as SettleUnpaidCheckoutDeps["fulfil"],
      loadOrder: (async (_t: string, id: string) => ({ id, status: "checkout_pending", stripe_checkout_session_id: `cs_${id}` })) as never,
      stripe: (() => ({ checkout: { sessions: { retrieve: async (id: string) => ({ id, status: "expired" }), expire: vi.fn() } } })) as never,
      keyLivemode: () => true,
      now: () => new Date(plus(T0, 100 * H)),
      log: (async () => {}) as never,
    };
    const deps = { ...fakeDeps(state), settleUnpaidCheckout: (r: CreatorOrderStateRow) => settleUnpaidCheckout(r, settleDeps) };

    let page = 0;
    const out = await runCreatorDeadlineSweep({ info: () => {}, error: () => {} }, deps, {
      claimDue: async () => (page++ === 0 ? [testBooking, testOffer, liveExpired, livePaid] : []),
      listDuePayouts: async () => [],
    });

    expect(out.claimed).toBe(4);
    for (const id of ["test-booking", "test-offer", "live-expired"]) {
      expect(state.orders[id as keyof typeof state.orders]).toMatchObject({ status: "cancelled", closed_reason: "checkout_abandoned" });
    }
    expect(state.orders["live-paid"].status).toBe("checkout_pending");
    expect(fulfil.mock.calls.map((c) => c[0].order_id)).toEqual(["live-expired", "live-paid"]);
    expect(state.money).toEqual(["cancel_hold:checkout_abandoned", "cancel_hold:checkout_abandoned", "cancel_hold:checkout_abandoned"]);
  });

  it("the timer deps carry the Stripe check, so the sweep never closes an unpaid order blind", () => {
    expect(typeof timerDeps().settleUnpaidCheckout).toBe("function");
  });

  it("an empty sweep touches nothing at all", async () => {
    const state = { orders: {}, money: [] as string[] };
    const out = await runCreatorDeadlineSweep({ info: () => {}, error: () => {} }, fakeDeps(state), {
      claimDue: async () => [],
      listDuePayouts: async () => [],
    });
    expect(out).toEqual({ claimed: 0, acted: 0, skipped: 0, payouts_attempted: 0, payouts_sent: 0 });
    expect(state.money).toEqual([]);
  });
});

describe("window reminders (spec item 38)", () => {
  const armed = { order_id: "22222222-2222-2222-2222-222222222222" };

  it("an unpaid order gets no reminder on either side (no job until it is paid)", async () => {
    const sendWindowReminder = vi.fn();
    const deadline_at = plus(T0, 72 * H);
    const res = await sendCreatorWindowReminder(
      { ...armed, window: "offer_expiry", deadline_at, at_hours: 24 },
      {
        resolveTenant: async () => TENANT,
        loadOrder: async () =>
          row({ source: "offer", status: "checkout_pending", next_deadline_kind: "offer_expiry", next_deadline_at: deadline_at }),
        notify: { notify: vi.fn(), notifyBothSides: vi.fn(), sendWindowReminder } as never,
      },
    );
    expect(res).toBe("window_closed");
    expect(sendWindowReminder).not.toHaveBeenCalled();
  });

  it.each([
    ["accept", "awaiting_acceptance", "creator"],
    ["review", "submitted", "tenant"],
    ["cancel_response", "cancel_requested", "creator"],
  ] as const)("sends the %s reminder only to the side that has to act", async (window, status, only) => {
    const sent: string[] = [];
    const res = await sendCreatorWindowReminder(
      { ...armed, window, deadline_at: plus(T0, 72 * H), at_hours: 24 },
      {
        resolveTenant: async () => TENANT,
        loadOrder: async () => row({ status, next_deadline_kind: window }),
        notify: {
          notify: (async () => ({ written: true, emailed: true })) as never,
          notifyBothSides: (async () => ({ creator: null, tenant: null })) as never,
          sendWindowReminder: (async (a: { recipient: { kind: string } }) => {
            sent.push(a.recipient.kind);
            return { written: true, emailed: true };
          }) as never,
        },
      },
    );
    expect(res).toBe("sent");
    expect(sent).toEqual([only]);
  });

  it("sends the deadline instant it was armed with, unchanged (invariant 5)", async () => {
    const sent: { recipient: string; deadline_at: unknown; at_hours: number }[] = [];
    const res = await sendCreatorWindowReminder(
      { ...armed, window: "accept", deadline_at: plus(T0, 72 * H), at_hours: 24 },
      {
        resolveTenant: async () => TENANT,
        loadOrder: async () => row(),
        notify: {
          notify: (async () => ({ written: true, emailed: true })) as never,
          notifyBothSides: (async () => ({ creator: null, tenant: null })) as never,
          sendWindowReminder: (async (a: {
            recipient: { kind: string };
            deadline_at: unknown;
            at_hours: number;
          }) => {
            sent.push({ recipient: a.recipient.kind, deadline_at: a.deadline_at, at_hours: a.at_hours });
            return { written: true, emailed: true };
          }) as never,
        },
      },
    );
    expect(res).toBe("sent");
    expect(sent.map((s) => s.recipient)).toEqual(["creator"]);
    expect(sent[0].deadline_at).toBe(plus(T0, 72 * H));
  });

  it("sends when the row spells the same instant the way PostgREST does", async () => {
    const armedAt = plus(T0, 72 * H);
    const asPostgrest = armedAt.replace("Z", "+00:00");
    expect(asPostgrest).not.toBe(armedAt);
    expect(new Date(asPostgrest).getTime()).toBe(new Date(armedAt).getTime());

    const send = vi.fn(async () => ({ written: true, emailed: true }));
    const res = await sendCreatorWindowReminder(
      { ...armed, window: "accept", deadline_at: armedAt, at_hours: 24 },
      {
        resolveTenant: async () => TENANT,
        loadOrder: async () => row({ next_deadline_at: asPostgrest }),
        notify: {
          notify: (async () => ({ written: true, emailed: true })) as never,
          notifyBothSides: (async () => ({ creator: null, tenant: null })) as never,
          sendWindowReminder: send as never,
        },
      },
    );
    expect(res).toBe("sent");
    expect(send).toHaveBeenCalled();
  });

  it("still refuses a deadline that is a genuinely different instant", async () => {
    const send = vi.fn();
    const res = await sendCreatorWindowReminder(
      { ...armed, window: "accept", deadline_at: plus(T0, 72 * H), at_hours: 24 },
      {
        resolveTenant: async () => TENANT,
        loadOrder: async () => row({ next_deadline_at: plus(T0, 72 * H + 60_000) }),
        notify: {
          notify: (async () => ({ written: true, emailed: true })) as never,
          notifyBothSides: (async () => ({ creator: null, tenant: null })) as never,
          sendWindowReminder: send as never,
        },
      },
    );
    expect(res).toBe("window_closed");
    expect(send).not.toHaveBeenCalled();
  });

  it("stays quiet once the window has closed", async () => {
    const send = vi.fn();
    const res = await sendCreatorWindowReminder(
      { ...armed, window: "accept", deadline_at: plus(T0, 72 * H), at_hours: 60 },
      {
        resolveTenant: async () => TENANT,
        loadOrder: async () => row({ status: "in_progress", next_deadline_kind: "due", next_deadline_at: null }),
        notify: {
          notify: (async () => ({ written: true, emailed: true })) as never,
          notifyBothSides: (async () => ({ creator: null, tenant: null })) as never,
          sendWindowReminder: send as never,
        },
      },
    );
    expect(res).toBe("window_closed");
    expect(send).not.toHaveBeenCalled();
  });

  it("stays quiet when the deadline moved under it (an approved extension)", async () => {
    const send = vi.fn();
    const res = await sendCreatorWindowReminder(
      { ...armed, window: "accept", deadline_at: plus(T0, 72 * H), at_hours: 24 },
      {
        resolveTenant: async () => TENANT,
        loadOrder: async () => row({ next_deadline_at: plus(T0, 200 * H) }),
        notify: {
          notify: (async () => ({ written: true, emailed: true })) as never,
          notifyBothSides: (async () => ({ creator: null, tenant: null })) as never,
          sendWindowReminder: send as never,
        },
      },
    );
    expect(res).toBe("window_closed");
    expect(send).not.toHaveBeenCalled();
  });

  it("stays quiet for an order that is not this workspace's", async () => {
    const send = vi.fn();
    const res = await sendCreatorWindowReminder(
      { ...armed, window: "review", deadline_at: plus(T0, 72 * H), at_hours: 24 },
      {
        resolveTenant: async () => null,
        loadOrder: async () => null,
        notify: {
          notify: (async () => ({ written: true, emailed: true })) as never,
          notifyBothSides: (async () => ({ creator: null, tenant: null })) as never,
          sendWindowReminder: send as never,
        },
      },
    );
    expect(res).toBe("window_closed");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("arming", () => {
  it("arms a deadline sleeper with only the fields the worker re-derives from", async () => {
    await armCreatorDeadline({
      order_id: "o1",
      tenant_id: TENANT,
      deadline: { kind: "accept", deadline_at: plus(T0, 72 * H) },
    });
    expect(m.send).toHaveBeenCalledWith({
      name: "creator/order.deadline.armed",
      data: { order_id: "o1", tenant_id: TENANT, deadline_at: plus(T0, 72 * H), kind: "accept" },
    });
  });

  it("realCreatorOrderDeps arms for real, not with a no-op", async () => {
    const { realCreatorOrderDeps } = await import("@/services/creators/order-transitions");

    await realCreatorOrderDeps.armDeadline({
      order_id: "o1",
      tenant_id: TENANT,
      deadline: { kind: "accept", deadline_at: plus(T0, 72 * H) },
    });
    expect(m.send).toHaveBeenCalledWith({
      name: "creator/order.deadline.armed",
      data: { order_id: "o1", tenant_id: TENANT, deadline_at: plus(T0, 72 * H), kind: "accept" },
    });

    await realCreatorOrderDeps.armPayoutBuffer({
      order_id: "o1",
      tenant_id: TENANT,
      payout_ready_at: plus(T0, 10 * 24 * H),
    });
    expect(m.send).toHaveBeenCalledWith({
      name: "creator/order.payout.armed",
      data: { order_id: "o1", tenant_id: TENANT, payout_ready_at: plus(T0, 10 * 24 * H) },
    });
  });

  it("arms the payout buffer sleeper", async () => {
    await armCreatorPayoutBuffer({
      order_id: "o1",
      tenant_id: TENANT,
      payout_ready_at: plus(T0, 10 * 24 * H),
    });
    expect(m.send).toHaveBeenCalledWith({
      name: "creator/order.payout.armed",
      data: { order_id: "o1", tenant_id: TENANT, payout_ready_at: plus(T0, 10 * 24 * H) },
    });
  });
});

describe("grace_nudge: the late-delivery nudge inside the no-show grace", () => {
  const due = plus(T0, 24 * H);
  const graceEnd = plus(due, 72 * H);
  const late = (over: Partial<CreatorOrderStateRow> = {}) =>
    row({ status: "in_progress", due_at: due, next_deadline_kind: "no_show_grace", next_deadline_at: graceEnd, ...over });
  const run = (order: CreatorOrderStateRow | null, deadline_at = graceEnd) => {
    const sent: Array<Record<string, unknown>> = [];
    const notify = (async (a: Record<string, unknown>) => {
      sent.push(a);
      return { written: true, emailed: true };
    }) as never;
    return sendCreatorGraceNudge(
      { order_id: "22222222-2222-2222-2222-222222222222", deadline_at },
      {
        resolveTenant: async () => TENANT,
        loadOrder: async () => order,
        businessName: async () => "Acme",
        notify: { notify, notifyBothSides: vi.fn() as never, sendWindowReminder: vi.fn() as never },
      },
    ).then((res) => ({ res, sent }));
  };

  it("goes to the creator only, with the grace deadline and a per-grace key", async () => {
    const { res, sent } = await run(late());
    expect(res).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(sent[0].recipient).toEqual({ kind: "creator", human_member_id: CREATOR });
    expect(sent[0].event).toBe("grace_nudge");
    expect(sent[0].vars).toMatchObject({
      business_name: "Acme",
      job_title: "3 ad videos",
      deadline_kind: "no_show_grace",
      deadline_at: graceEnd,
    });
    expect(sent[0].dedupe_window).toBe(`grace:${new Date(graceEnd).getTime()}`);
  });

  it("matches the row's deadline however PostgREST spells it", async () => {
    const { res } = await run(late({ next_deadline_at: graceEnd.replace("Z", "+00:00") }));
    expect(res).toBe("sent");
  });

  it.each([
    ["the draft arrived", late({ status: "submitted", next_deadline_kind: "review" })],
    ["the job was cancelled", late({ status: "cancelled" as CreatorOrderStateRow["status"] })],
    ["an extension moved the grace", late({ next_deadline_at: plus(graceEnd, 48 * H) })],
    ["the order is still before its due date", late({ next_deadline_kind: "due", next_deadline_at: due })],
    ["the order is gone", null],
  ])("sends nothing when %s", async (_label, order) => {
    const { res, sent } = await run(order);
    expect(res).toBe("window_closed");
    expect(sent).toHaveLength(0);
  });
});

async function replayDeadlineWait(data: { order_id: string; deadline_at: string; kind: string }, start: string) {
  const memo = new Map<string, unknown>();
  const ran: string[] = [];
  const INTERRUPT = Symbol("interrupt");
  vi.useFakeTimers();
  vi.setSystemTime(new Date(start));
  try {
    for (let i = 0; i < 20; i++) {
      const step = {
        sleepUntil: async (id: string, at: Date) => {
          if (memo.has(id)) return;
          memo.set(id, null);
          if (at.getTime() > Date.now()) vi.setSystemTime(at);
          throw INTERRUPT;
        },
        run: async (id: string, fn: () => unknown) => {
          if (memo.has(id)) return memo.get(id);
          ran.push(id);
          memo.set(id, id === "armed-at" ? await fn() : null);
          throw INTERRUPT;
        },
      };
      try {
        await m.handlers["creator-deadline-wait"]({ event: { data }, step, logger: { info: () => {} } });
        return ran;
      } catch (e) {
        if (e !== INTERRUPT) throw e;
      }
    }
    throw new Error("handler never finished");
  } finally {
    vi.useRealTimers();
  }
}

describe("creator-deadline-wait under Inngest replay", () => {
  const id = "22222222-2222-2222-2222-222222222222";

  it("sends the grace nudge after sleeping to it, then fires the deadline", async () => {
    const graceEnd = plus(T0, 72 * H);
    const ran = await replayDeadlineWait({ order_id: id, deadline_at: graceEnd, kind: "no_show_grace" }, T0);
    expect(ran).toEqual(["armed-at", "grace-nudge", "fire"]);
  });

  it("sends the 24h and 60h reminders after sleeping to them", async () => {
    const ran = await replayDeadlineWait({ order_id: id, deadline_at: plus(T0, 72 * H), kind: "accept" }, T0);
    expect(ran).toEqual(["armed-at", "remind-24h", "remind-60h", "fire"]);
  });

  it("skips a nudge whose instant had already passed when it was armed", async () => {
    const graceEnd = plus(T0, 72 * H);
    const ran = await replayDeadlineWait(
      { order_id: id, deadline_at: graceEnd, kind: "no_show_grace" },
      plus(T0, 60 * H),
    );
    expect(ran).toEqual(["armed-at", "fire"]);
  });
});

describe("an agent hire's order and its card close together (test 15)", () => {
  const agentOrder = (over: Partial<CreatorOrderStateRow> = {}) =>
    row({ id: "agent-order", source: "booking", status: "checkout_pending", next_deadline_kind: "checkout_expiry", next_deadline_at: plus(T0, 72 * H), ...over });
  const sweep = async (deps: CreatorOrderDeps, rows: CreatorOrderStateRow[]) => {
    let page = 0;
    return runCreatorDeadlineSweep({ info: () => {}, error: () => {} }, deps, {
      claimDue: async () => (page++ === 0 ? rows : []),
      listDuePayouts: async () => [],
    });
  };

  beforeEach(() => {
    m.retire.mockReset();
    m.retire.mockResolvedValue(1);
  });

  it("the deadline closes the unpaid order AND retires its pending hire card", async () => {
    const order = agentOrder();
    const state = { orders: { "agent-order": order }, money: [] as string[] };
    const deps = { ...fakeDeps(state), settleUnpaidCheckout: async () => ({ action: "close" as const }) };
    const out = await sweep(deps, [order]);
    expect(out.acted).toBe(1);
    expect(state.orders["agent-order"]).toMatchObject({ status: "cancelled", closed_reason: "checkout_abandoned" });
    expect(state.money).toEqual(["cancel_hold:checkout_abandoned"]);
    expect(m.retire).toHaveBeenCalledTimes(1);
    expect(m.retire).toHaveBeenCalledWith({ tenant_id: TENANT, order_id: "agent-order" });
  });

  it("no card is retired when the close did not happen", async () => {
    const order = agentOrder();
    const paidMeanwhile = { orders: { "agent-order": { ...order, status: "awaiting_acceptance" as const } }, money: [] as string[] };
    await sweep({ ...fakeDeps(paidMeanwhile), settleUnpaidCheckout: async () => ({ action: "close" as const }) }, [order]);
    expect(paidMeanwhile.orders["agent-order"].status).toBe("awaiting_acceptance");

    const stillOpen = { orders: { "agent-order": order }, money: [] as string[] };
    await sweep({ ...fakeDeps(stillOpen), settleUnpaidCheckout: async () => ({ action: "wait" as const, until: plus(T0, 80 * H), reason: "session_open" as const }) }, [order]);
    expect(stillOpen.orders["agent-order"].status).toBe("checkout_pending");

    expect(m.retire).not.toHaveBeenCalled();
  });

  it("a card retire that fails never undoes or fails the close", async () => {
    m.retire.mockRejectedValue(new Error("db down"));
    const order = agentOrder();
    const state = { orders: { "agent-order": order }, money: [] as string[] };
    const log = vi.fn(async () => {});
    const deps = { ...fakeDeps(state), log: log as unknown as CreatorOrderDeps["log"], settleUnpaidCheckout: async () => ({ action: "close" as const }) };
    const out = await sweep(deps, [order]);
    expect(out.acted).toBe(1);
    expect(state.orders["agent-order"].status).toBe("cancelled");
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ code: "hire_card_retire_failed", tenant_id: TENANT }));
  });
});
