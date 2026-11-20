import { describe, expect, it } from "vitest";
import { applyCreatorOrderTransition, type CreatorOrderDeps } from "../order-transitions";
import { runBusinessAction, type RunBusinessActionDeps } from "../business-actions";
import type { CreatorOrderStateRow } from "../orders-db";
import type { CreatorOrderStatus, CreatorOrderTrigger } from "../order-state";

const TENANT = "11111111-1111-1111-1111-111111111111";
const ORDER = "22222222-2222-2222-2222-222222222222";
const CREATOR = "33333333-3333-3333-3333-333333333333";
const T0 = "2026-09-11T00:00:00.000Z";

function makeOrder(over: Partial<CreatorOrderStateRow> = {}): CreatorOrderStateRow {
  return {
    id: ORDER,
    tenant_id: TENANT,
    human_member_id: CREATOR,
    source: "booking",
    status: "submitted",
    closed_reason: null,
    created_at: T0,
    due_at: null,
    extension_requested_due_at: null,
    extension_state: null,
    next_deadline_at: null,
    next_deadline_kind: null,
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

type TransferMode = "ok" | "throws" | "no_account";

function world(
  initial: CreatorOrderStateRow,
  opts: {
    openDispute?: boolean;
    transfer?: TransferMode;
    resolveFails?: boolean;
    beforeParkAnswer?: (w: { order: CreatorOrderStateRow; transferId: string | null }) => void;
  } = {},
) {
  const state = {
    order: { ...initial },
    disputes: opts.openDispute ? [{ order_id: initial.id, status: "open" as "open" | "resolved" }] : [],
    transferId: null as string | null,
    transferMode: opts.transfer ?? "ok",
  };
  const stripeTransfers: string[] = [];
  const transferAnswers: string[] = [];
  const logs: { level: string; code: string }[] = [];
  const notices: { event: string; to: string }[] = [];
  const moneyCalls: string[] = [];
  const openDisputeFor = (oid: string) => state.disputes.some((d) => d.order_id === oid && d.status === "open");

  const deps: CreatorOrderDeps = {
    now: () => new Date(T0),
    log: (async (e: { level: string; code: string }) => {
      logs.push({ level: e.level, code: e.code });
    }) as unknown as CreatorOrderDeps["log"],
    loadOrder: async (tid, oid) =>
      tid === state.order.tenant_id && oid === state.order.id ? { ...state.order } : null,
    writeOrder: (async (a: {
      expected_status: CreatorOrderStatus;
      expected_payout_status?: string;
      patch: Partial<CreatorOrderStateRow>;
    }) => {
      if (state.order.status !== a.expected_status) return null;
      if (a.expected_payout_status !== undefined && state.order.payout_status !== a.expected_payout_status) return null;
      state.order = { ...state.order, ...a.patch } as CreatorOrderStateRow;
      return { ...state.order };
    }) as unknown as CreatorOrderDeps["writeOrder"],
    latestSubmissionAt: async () => null,
    submissionRounds: async () => 1,
    openDispute: async () => "opened",
    resolveDispute: async ({ order_id }) => {
      if (opts.resolveFails) throw new Error("creator_disputes update timed out");
      let n = 0;
      for (const d of state.disputes) {
        if (d.order_id === order_id && d.status === "open") {
          d.status = "resolved";
          n += 1;
        }
      }
      return n;
    },
    hasOpenDispute: async (_t, oid) => openDisputeFor(oid),
    markMissedDeadline: async () => 0,
    money: {
      capture: (async () => {
        throw new Error("capture must not run here");
      }) as unknown as CreatorOrderDeps["money"]["capture"],
      cancelHold: (async () => {
        throw new Error("cancelHold must not run here");
      }) as unknown as CreatorOrderDeps["money"]["cancelHold"],
      refund: (async (a: { cause: string; amount_cents?: number }) => {
        moneyCalls.push(`refund:${a.cause}`);
        return {
          refund_id: "re_1",
          refunded_cents: a.amount_cents ?? 16_500,
          already_refunded: false,
          reversed_cents: 0,
          reversal_shortfall_cents: 0,
          needs_staff_review: false,
        };
      }) as unknown as CreatorOrderDeps["money"]["refund"],
      transfer: (async (a: { order_id: string; cause: string }) => {
        moneyCalls.push(`transfer:${a.cause}`);
        const o = state.order;
        if (o.payout_status === "transferred" && state.transferId) {
          transferAnswers.push("already_transferred");
          return { ok: true, transfer_id: state.transferId, amount_cents: 12_750, already_transferred: true, recorded: true };
        }
        if (state.transferMode === "no_account") {
          opts.beforeParkAnswer?.(state);
          transferAnswers.push("awaiting_payout_account");
          return { ok: false, reason: "awaiting_payout_account", message: "waits" };
        }
        if (state.transferMode === "throws") {
          transferAnswers.push("threw");
          throw new Error("Stripe accounts.retrieve failed: connection reset");
        }
        const claimable =
          o.status === "completed" &&
          o.payout_status === "ready" &&
          !!o.payout_ready_at &&
          o.payout_ready_at <= T0 &&
          !openDisputeFor(o.id);
        if (!claimable) {
          transferAnswers.push("claim_lost");
          return { ok: false, reason: "claim_lost", message: "held" };
        }
        const amount = o.payout_amount_cents ?? o.creator_payout_cents;
        stripeTransfers.push(`${o.id}:${amount}`);
        state.transferId = `tr_${stripeTransfers.length}`;
        state.order = { ...o, payout_status: "transferred" };
        transferAnswers.push("sent");
        return { ok: true, transfer_id: state.transferId, amount_cents: amount, already_transferred: false, recorded: true };
      }) as unknown as CreatorOrderDeps["money"]["transfer"],
    },
    notify: {
      notify: async ({ event, recipient }) => {
        notices.push({ event, to: recipient.kind });
        return { written: true, emailed: true };
      },
      notifyBothSides: async ({ event }) => {
        notices.push({ event, to: "both" });
        return { creator: { written: true, emailed: true }, tenant: { written: true, emailed: true } };
      },
      sendWindowReminder: async () => ({ written: true, emailed: true }),
    },
    armDeadline: async () => {},
    armPayoutBuffer: async () => {},
    businessName: async () => "UpcarAI",
    priorCompletedWithCreator: async () => false,
  };

  return { state, deps, stripeTransfers, transferAnswers, logs, notices, moneyCalls };
}

function run(w: ReturnType<typeof world>, trigger: CreatorOrderTrigger, extra: Record<string, unknown> = {}) {
  return applyCreatorOrderTransition({ tenant_id: TENANT, order_id: ORDER, trigger, ...extra }, w.deps);
}

describe("approve whose transfer THROWS after the order is already completed", () => {
  it("still completes, tells the creator, flags staff, and never throws", async () => {
    const w = world(makeOrder(), { transfer: "throws" });

    const res = await run(w, "approve", { actor: "business" });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.needs_staff_review).toBe(true);
    expect(res.payout_waiting).toBe(false);
    expect(w.state.order.status).toBe("completed");
    expect(w.state.order.payout_status).toBe("ready");
    expect(w.stripeTransfers).toEqual([]);
    expect(w.notices).toEqual([{ event: "approved", to: "creator" }]);
    expect(w.logs).toContainEqual({ level: "error", code: "transfer_failed" });
  });

  it("leaves the payout claimable, so the buffer sweep's retry pays the creator", async () => {
    const w = world(makeOrder(), { transfer: "throws" });
    await run(w, "approve", { actor: "business" });

    w.state.transferMode = "ok";
    const retry = await run(w, "payout_buffer_elapsed", { actor: "system" });

    expect(retry.ok).toBe(true);
    expect(w.stripeTransfers).toEqual([`${ORDER}:12750`]);
    expect(w.state.order.payout_status).toBe("transferred");
    expect(w.notices.filter((n) => n.event === "paid")).toEqual([{ event: "paid", to: "creator" }]);
  });

  it("runBusinessAction still lands the approved video in the library and reports success", async () => {
    const w = world(makeOrder(), { transfer: "throws" });
    const library: string[] = [];
    const bdeps: RunBusinessActionDeps = {
      transition: (a) => applyCreatorOrderTransition(a, w.deps),
      library: {
        createLibraryAssetOnApproval: async (t, o) => {
          library.push(`${t}:${o}`);
          return { created: true, asset_id: "asset-1" };
        },
      },
      thread: {
        readThread: async () => ({ available: false, thread_id: null, messages: [] }),
        postMessage: async () => ({ posted: true }),
      },
      log: (async () => {}) as never,
    };

    const res = await runBusinessAction(
      { tenant_id: TENANT, order_id: ORDER, action: "approve", user_id: "u1" },
      bdeps,
    );

    expect(res.ok).toBe(true);
    expect(res.library_asset_created).toBe(true);
    expect(library).toEqual([`${TENANT}:${ORDER}`]);
    expect(w.state.order.status).toBe("completed");
  });
});

describe("mediation that pays the creator resolves the dispute BEFORE the transfer", () => {
  it("pay_full from in_dispute pays the creator in the same transition", async () => {
    const w = world(makeOrder({ status: "in_dispute" }), { openDispute: true });

    const res = await run(w, "mediation_pay_full", { actor: "staff", actor_user_id: "staff-1" });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(w.transferAnswers).toEqual(["sent"]);
    expect(w.stripeTransfers).toEqual([`${ORDER}:12750`]);
    expect(w.state.order.payout_status).toBe("transferred");
    expect(w.state.disputes).toEqual([{ order_id: ORDER, status: "resolved" }]);
    expect(res.needs_staff_review).toBe(false);
  });

  it("pay_full on a completed order disputed inside its buffer pays in the same transition", async () => {
    const w = world(
      makeOrder({ status: "completed", closed_reason: "auto_accepted", payout_status: "ready", payout_ready_at: T0 }),
      { openDispute: true },
    );

    const res = await run(w, "mediation_pay_full", { actor: "staff" });

    expect(res.ok).toBe(true);
    expect(w.transferAnswers).toEqual(["sent"]);
    expect(w.state.order.payout_status).toBe("transferred");
  });

  it("pay_part refunds first, then pays the creator's share in the same transition", async () => {
    const w = world(makeOrder({ status: "in_dispute" }), { openDispute: true });

    const res = await run(w, "mediation_pay_part", {
      actor: "staff",
      creator_amount_cents: 6_000,
      refund_amount_cents: 8_000,
    });

    expect(res.ok).toBe(true);
    expect(w.moneyCalls).toEqual(["refund:mediation", "transfer:mediation"]);
    expect(w.stripeTransfers).toEqual([`${ORDER}:6000`]);
    expect(w.state.disputes[0].status).toBe("resolved");
  });

  it("a failed dispute resolve is surfaced loudly, not swallowed", async () => {
    const w = world(makeOrder({ status: "in_dispute" }), { openDispute: true, resolveFails: true });

    const res = await run(w, "mediation_pay_full", { actor: "staff" });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.needs_staff_review).toBe(true);
    expect(w.logs).toContainEqual({ level: "error", code: "dispute_resolve_failed" });
    expect(w.stripeTransfers).toEqual([]);
    expect(w.transferAnswers).toEqual(["claim_lost"]);
    expect(w.state.disputes[0].status).toBe("open");
  });
});

describe("parking a payout on Stripe setup never overwrites a payout that already left", () => {
  it("a concurrent payout refresh that transferred first keeps `transferred`", async () => {
    const w = world(makeOrder(), {
      transfer: "no_account",
      beforeParkAnswer: (s) => {
        s.order = { ...s.order, payout_status: "transferred" };
        s.transferId = "tr_refresh";
      },
    });

    const res = await run(w, "approve", { actor: "business" });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(w.state.order.payout_status).toBe("transferred");
    expect(res.payout_waiting).toBe(false);
    expect(w.notices.map((n) => n.event)).not.toContain("payout_setup_needed");

    w.state.transferMode = "ok";
    await run(w, "payout_buffer_elapsed", { actor: "system" });
    expect(w.stripeTransfers).toEqual([]);
  });

  it("with no race the payout still parks and the creator is asked to finish setup", async () => {
    const w = world(makeOrder(), { transfer: "no_account" });

    const res = await run(w, "approve", { actor: "business" });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(w.state.order.payout_status).toBe("awaiting_payout_account");
    expect(res.payout_waiting).toBe(true);
    expect(w.notices.map((n) => n.event)).toContain("payout_setup_needed");
  });
});
