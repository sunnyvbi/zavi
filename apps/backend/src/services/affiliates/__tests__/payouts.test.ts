import { describe, it, expect, vi } from "vitest";
import { definitelyNotSent, runAffiliatePayouts, type PayoutDeps } from "../payouts";

type P = { id: string; member_id: string; amount_cents: number; state: string; updated_at: string; first_attempt_at?: string; destination_account?: string };

function deps(over: Partial<PayoutDeps> = {}, stripeOver: Record<string, unknown> = {}, start: P[] = []) {
  const moves: string[] = [];
  let payouts: P[] = [...start];
  const stripe = {
    accounts: { retrieve: vi.fn(async () => ({ id: "acct_1" })) },
    balance: { retrieve: vi.fn(async () => ({ available: [{ currency: "usd", amount: 100000 }] })) },
    transfers: {
      create: vi.fn(async () => ({ id: "tr_1" })),
      list: vi.fn(async () => ({ data: [] })),
      createReversal: vi.fn(async () => ({ id: "trr_1" })),
      listReversals: vi.fn(async () => ({ data: [] })),
    },
    ...stripeOver,
  };
  const d: PayoutDeps = {
    enabled: async () => true,
    stripe: () => stripe as never,
    livemode: true,
    membersToVisit: async (_l, after) => (after ? [] : ["m1"]),
    start: vi.fn(async (id: string) => {
      const p = payouts.find((x) => x.id === id);
      if (!p || p.state !== "claimed") return { outcome: "wrong_state" };
      moves.push(`${id}:claimed->transferring`);
      payouts = payouts.map((x) => (x.id === id ? { ...x, state: "transferring", destination_account: "acct_1" } : x));
      return { outcome: "transferring", amount_cents: p.amount_cents };
    }),
    payoutAccount: async () => ({ stripe_account_id: "acct_1", disabled_reason: null }),
    transfersActive: () => true,
    approved: async () => true,
    claim: vi.fn(async () => {
      payouts = [{ id: "p1", member_id: "m1", amount_cents: 2400, state: "claimed", updated_at: new Date().toISOString() }];
      return { outcome: "claimed", payout_id: "p1", amount_cents: 2400 };
    }),
    move: vi.fn(async (id: string, from: string, to: string, t?: string | null) => {
      moves.push(`${id}:${from}->${to}${t ? ":" + t : ""}`);
      payouts = payouts.map((p) => (p.id === id ? { ...p, state: to } : p));
      return "moved";
    }),
    openPayouts: async (_l, states, after) => (after ? [] : payouts.filter((p) => states.includes(p.state))),
    reversalClaim: vi.fn(async () => ({ outcome: "no_debt" })),
    reversalMove: vi.fn(async () => "moved"),
    reversalStart: vi.fn(async () => ({ outcome: "reconcile", amount_cents: 600 })),
    purgeClicks: vi.fn(async () => 0),
    drainInbox: vi.fn(async () => 0),
    alert: vi.fn(async () => undefined),
    log: () => {},
    now: () => new Date(),
    ...over,
  };
  return { d, stripe, moves };
}

describe("affiliate payouts", () => {
  it("off by default: nothing is claimed or sent, but parked events still accrue", async () => {
    const { d, stripe } = deps({ enabled: async () => false });
    expect(await runAffiliatePayouts(d)).toMatchObject({ disabled: true, sent: 0 });
    expect(d.claim).not.toHaveBeenCalled();
    expect(stripe.transfers.create).not.toHaveBeenCalled();
    expect(d.drainInbox).toHaveBeenCalled();
  });
  it("the 24-hour window runs from the FIRST attempt, not the last state change", async () => {
    const stuck = { id: "p7", member_id: "m1", amount_cents: 2000, state: "reconcile", updated_at: new Date().toISOString(), first_attempt_at: new Date(Date.now() - 30 * 3600_000).toISOString() };
    const { d, stripe } = deps({ membersToVisit: async () => [] }, {}, [stuck]);
    await runAffiliatePayouts(d);
    expect(stripe.transfers.create).not.toHaveBeenCalled();
  });
  it("a retry goes to the account fixed at the first attempt, never a reconnected one", async () => {
    const stuck = { id: "p5", member_id: "m1", amount_cents: 2000, state: "reconcile", updated_at: new Date().toISOString(), first_attempt_at: new Date().toISOString(), destination_account: "acct_OLD" };
    const { d, stripe } = deps({ membersToVisit: async () => [], payoutAccount: async () => ({ stripe_account_id: "acct_NEW", disabled_reason: null }) }, {}, [stuck]);
    await runAffiliatePayouts(d);
    expect(stripe.transfers.create).toHaveBeenCalledWith(expect.objectContaining({ destination: "acct_OLD" }), { idempotencyKey: "affiliate-payout-p5" });
  });
  it("an unsettled payout of a creator no longer approved is never retried", async () => {
    const stuck = { id: "p6", member_id: "m1", amount_cents: 2000, state: "transferring", updated_at: new Date().toISOString(), first_attempt_at: new Date().toISOString() };
    const { d, stripe, moves } = deps({ membersToVisit: async () => [], approved: async () => false }, {}, [stuck]);
    await runAffiliatePayouts(d);
    expect(stripe.transfers.create).not.toHaveBeenCalled();
    expect(moves).toEqual(["p6:transferring->reconcile"]);
  });
  it("claims for the key's Stripe mode only, checks the live account and the balance, transfers once with a frozen key", async () => {
    const { d, stripe, moves } = deps();
    expect(await runAffiliatePayouts(d)).toMatchObject({ sent: 1 });
    expect(d.claim).toHaveBeenCalledWith("m1", true, expect.any(Date));
    expect(stripe.transfers.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 2400, currency: "usd", destination: "acct_1", transfer_group: "affiliate_p1" }),
      { idempotencyKey: "affiliate-payout-p1" },
    );
    expect(moves).toEqual(["p1:claimed->transferring", "p1:transferring->sent:tr_1"]);
  });
  it("a creator with no payout account is not claimed", async () => {
    const { d } = deps({ payoutAccount: async () => null });
    expect(await runAffiliatePayouts(d)).toMatchObject({ waiting: 1 });
    expect(d.claim).not.toHaveBeenCalled();
  });
  it("too little Stripe balance: stays claimed, staff told, tried tomorrow", async () => {
    const { d, stripe, moves } = deps({}, { balance: { retrieve: vi.fn(async () => ({ available: [{ currency: "usd", amount: 100 }] })) } });
    expect(await runAffiliatePayouts(d)).toMatchObject({ waiting: 1, sent: 0 });
    expect(stripe.transfers.create).not.toHaveBeenCalled();
    expect(moves).toEqual([]);
    expect(d.alert).toHaveBeenCalled();
  });
  it("a definite refusal fails the payout; an unclear one goes to reconcile", async () => {
    const refused = deps({}, { transfers: { create: vi.fn(async () => Promise.reject(Object.assign(new Error("No such destination"), { statusCode: 400 }))), list: vi.fn(async () => ({ data: [] })) } });
    await runAffiliatePayouts(refused.d);
    expect(refused.moves).toEqual(["p1:claimed->transferring", "p1:transferring->failed"]);
    const unclear = deps({}, { transfers: { create: vi.fn(async () => Promise.reject(new Error("socket hang up"))), list: vi.fn(async () => ({ data: [] })) } });
    await runAffiliatePayouts(unclear.d);
    expect(unclear.moves).toEqual(["p1:claimed->transferring", "p1:transferring->reconcile"]);
    expect(definitelyNotSent({ statusCode: 500 })).toBe(false);
    expect(definitelyNotSent({ statusCode: 429 })).toBe(false);
  });
  it("a payout stuck in transferring or reconcile is settled: found -> sent; not found -> asked again with the SAME key", async () => {
    const stuck: P = { id: "p9", member_id: "m1", amount_cents: 2000, state: "transferring", updated_at: new Date().toISOString(), destination_account: "acct_1" } as P;
    const found = deps({ membersToVisit: async () => [] }, { transfers: { create: vi.fn(), list: vi.fn(async () => ({ data: [{ id: "tr_9" }] })) } }, [stuck]);
    await runAffiliatePayouts(found.d);
    expect(found.moves).toEqual(["p9:transferring->sent:tr_9"]);
    expect(found.stripe.transfers.create).not.toHaveBeenCalled();
    const again = deps({ membersToVisit: async () => [] }, {}, [{ ...stuck, state: "reconcile" }]);
    await runAffiliatePayouts(again.d);
    expect(again.stripe.transfers.create).toHaveBeenCalledWith(expect.anything(), { idempotencyKey: "affiliate-payout-p9" });
    expect(again.moves).toEqual(["p9:reconcile->sent:tr_1"]);
  });
  it("past Stripe's 24-hour key window an unsettled payout goes to a person, never re-sent", async () => {
    const old = new Date(Date.now() - 30 * 3600_000).toISOString();
    const { d, stripe, moves } = deps({ membersToVisit: async () => [] }, {}, [{ id: "p8", member_id: "m1", amount_cents: 2000, state: "transferring", updated_at: old }]);
    await runAffiliatePayouts(d);
    expect(stripe.transfers.create).not.toHaveBeenCalled();
    expect(moves).toEqual(["p8:transferring->reconcile"]);
    expect(d.alert).toHaveBeenCalledWith(expect.stringMatching(/idempotency window/));
  });
  it("a refund on money already paid: marked in flight BEFORE Stripe is called, then reversed on the paid transfer", async () => {
    const { d, stripe } = deps({ reversalClaim: vi.fn(async () => ({ outcome: "claimed", reversal_id: "r1", transfer_id: "tr_old", amount_cents: 600, state: "claimed" })) });
    const s = await runAffiliatePayouts(d);
    expect(d.reversalStart).toHaveBeenCalledWith("r1");
    const calls = (d.reversalMove as ReturnType<typeof vi.fn>).mock.calls.map((c) => `${c[1]}->${c[2]}`);
    expect(calls).toEqual(["reconcile->sent"]);
    expect(stripe.transfers.createReversal).toHaveBeenCalledWith("tr_old", expect.objectContaining({ amount: 600 }), { idempotencyKey: "affiliate-reversal-r1" });
    expect(s.reversed).toBe(1);
  });
  it("a reversal whose debt was undone since the claim is cancelled at start, Stripe never called", async () => {
    const { d, stripe } = deps({
      reversalClaim: vi.fn(async () => ({ outcome: "claimed", reversal_id: "r3", transfer_id: "tr_old", amount_cents: 600, state: "claimed" })),
      reversalStart: vi.fn(async () => ({ outcome: "cancelled" })),
    });
    await runAffiliatePayouts(d);
    expect(stripe.transfers.createReversal).not.toHaveBeenCalled();
  });
  it("the reversal sends the amount recomputed at start", async () => {
    const { d, stripe } = deps({
      reversalClaim: vi.fn(async () => ({ outcome: "claimed", reversal_id: "r4", transfer_id: "tr_old", amount_cents: 600, state: "claimed" })),
      reversalStart: vi.fn(async () => ({ outcome: "reconcile", amount_cents: 250 })),
    });
    await runAffiliatePayouts(d);
    expect(stripe.transfers.createReversal).toHaveBeenCalledWith("tr_old", expect.objectContaining({ amount: 250 }), expect.anything());
  });
  it("an unclear reversal is never sent again: not in Stripe after an hour -> closed", async () => {
    const empty = (async function* () {})();
    const { d, stripe } = deps(
      { reversalClaim: vi.fn(async () => ({ outcome: "open", reversal_id: "r5", transfer_id: "tr_old", amount_cents: 600, state: "reconcile", attempted_at: new Date(Date.now() - 2 * 3600_000).toISOString() })) },
      { transfers: { create: vi.fn(async () => ({ id: "tr_1" })), list: vi.fn(async () => ({ data: [] })), createReversal: vi.fn(), listReversals: vi.fn(() => empty) } },
    );
    await runAffiliatePayouts(d);
    expect(stripe.transfers.createReversal).not.toHaveBeenCalled();
    expect(d.reversalMove).toHaveBeenCalledWith("r5", "reconcile", "failed", null, expect.stringMatching(/an hour/));
  });
  it("an unsettled reversal is looked up in Stripe first, never blindly retried", async () => {
    const listed = (async function* () { yield { id: "trr_found", metadata: { affiliate_reversal_id: "r2" } }; })();
    const { d, stripe } = deps(
      { reversalClaim: vi.fn(async () => ({ outcome: "open", reversal_id: "r2", transfer_id: "tr_old", amount_cents: 600, state: "reconcile", attempted_at: new Date().toISOString() })) },
      { transfers: { create: vi.fn(async () => ({ id: "tr_1" })), list: vi.fn(async () => ({ data: [] })), createReversal: vi.fn(), listReversals: vi.fn(() => listed) } },
    );
    await runAffiliatePayouts(d);
    expect(stripe.transfers.createReversal).not.toHaveBeenCalled();
    expect(d.reversalMove).toHaveBeenCalledWith("r2", "reconcile", "sent", "trr_found");
  });
  it("a reversal Stripe refuses (balance already paid out) leaves the debt to net later", async () => {
    const { d } = deps(
      { reversalClaim: vi.fn(async () => ({ outcome: "claimed", reversal_id: "r1", transfer_id: "tr_old", amount_cents: 600, state: "claimed" })) },
      { transfers: { create: vi.fn(async () => ({ id: "tr_1" })), list: vi.fn(async () => ({ data: [] })), createReversal: vi.fn(async () => Promise.reject(Object.assign(new Error("insufficient funds"), { statusCode: 400 }))), listReversals: vi.fn() } },
    );
    await runAffiliatePayouts(d);
    expect(d.reversalMove).toHaveBeenCalledWith("r1", "reconcile", "failed", null, "insufficient funds");
  });
  it("one creator's error does not stop the run", async () => {
    let n = 0;
    const { d } = deps({
      membersToVisit: async (_l, after) => (after ? [] : ["bad", "m1"]),
      payoutAccount: async (m) => {
        if (m === "bad" && n++ === 0) throw new Error("db blip");
        return { stripe_account_id: "acct_1", disabled_reason: null };
      },
    });
    const s = await runAffiliatePayouts(d);
    expect(s.errors).toBe(1);
    expect(s.sent).toBe(1);
  });
  it("a first payout waits for approval and staff are told", async () => {
    const { d, stripe } = deps({ claim: vi.fn(async () => ({ outcome: "awaiting_approval", payout_id: "p1" })) });
    expect(await runAffiliatePayouts(d)).toMatchObject({ awaiting_approval: 1, sent: 0 });
    expect(stripe.transfers.create).not.toHaveBeenCalled();
    expect(d.alert).toHaveBeenCalledWith(expect.stringMatching(/first-payout approval/));
  });
  it("start fixes the destination: it is passed the creator's current account", async () => {
    const { d } = deps();
    await runAffiliatePayouts(d);
    expect(d.start).toHaveBeenCalledWith("p1", "acct_1", expect.any(Date));
  });
  it("send uses the amount the start step returns (a refund absorbed after the claim)", async () => {
    const { d, stripe } = deps({ start: vi.fn(async () => ({ outcome: "transferring", amount_cents: 1800 + 400 })) });
    await runAffiliatePayouts(d);
    expect(stripe.transfers.create).toHaveBeenCalledWith(expect.objectContaining({ amount: 2200 }), expect.anything());
  });
  it("a start that cancels (now under the minimum, or creator no longer approved) sends nothing", async () => {
    const { d, stripe } = deps({ start: vi.fn(async () => ({ outcome: "cancelled" })) });
    await runAffiliatePayouts(d);
    expect(stripe.transfers.create).not.toHaveBeenCalled();
  });
  it("old clicks are purged and parked events drained", async () => {
    const { d } = deps();
    await runAffiliatePayouts(d);
    expect(d.purgeClicks).toHaveBeenCalled();
    expect(d.drainInbox).toHaveBeenCalled();
  });
});
