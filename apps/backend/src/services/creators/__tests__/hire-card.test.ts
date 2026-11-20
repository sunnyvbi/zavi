import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeDb, type FakeDb } from "./fake-supabase";

const m = vi.hoisted(() => ({
  db: null as unknown as { client: { from: (t: string) => unknown } },
  rpc: vi.fn(),
  log: vi.fn(async () => {}),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: (t: string) => m.db.client.from(t), rpc: m.rpc }),
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: m.log }));

import { buildCreatorHireCard, declineCreatorHire, fileCreatorHireCard, retireCreatorHireCards } from "../hire-card";
import { latestCreatorCaps } from "@/services/decisions/creator-hire-budget";
import type { CreatorOrderDeps } from "../order-transitions";
import type { CreatorOrderStateRow } from "../orders-db";
import { cancelCreatorHold, type CreatorMoneyDeps } from "../orders-money";

const T = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const RUN = "22222222-2222-4222-8222-222222222222";
const ORDER = "33333333-3333-4333-8333-333333333333";
const OFFER = "44444444-4444-4444-8444-444444444444";
const CAPS_OLD = "55555555-5555-4555-8555-555555555555";
const CAPS_NEW = "66666666-6666-4666-8666-666666666666";

const HIRE = {
  tenant_id: T,
  run_id: RUN,
  order_id: ORDER,
  creator_name: "Maya",
  package_title: "3 ad videos",
  business_total_cents: 5_500,
  price_cents: 5_000,
  fee_cents: 500,
};

let db: FakeDb;
function seed(tables: Record<string, Array<Record<string, unknown>>>) {
  db = makeFakeDb({ cgo_creator_caps: [], agent_runs: [], channel_actions: [], creator_orders: [], creator_offers: [], ...tables });
  m.db = db;
}

const caps = (id: string, tenant_id: string, per_hire_usd: string, created_at: string) => ({
  id,
  tenant_id,
  per_hire_usd,
  per_week_usd: "500.00",
  why: "test",
  created_at,
});

beforeEach(() => {
  m.rpc.mockReset();
  m.log.mockClear();
  seed({});
});

describe("latestCreatorCaps", () => {
  it("returns the newest row of THIS tenant only, as numbers", async () => {
    seed({
      cgo_creator_caps: [
        caps(CAPS_OLD, T, "40.00", "2026-10-01T00:00:00Z"),
        caps(CAPS_NEW, T, "120.00", "2026-10-05T00:00:00Z"),
        caps("77777777-7777-4777-8777-777777777777", OTHER, "9999.00", "2026-10-09T00:00:00Z"),
      ],
    });
    expect(await latestCreatorCaps(T)).toEqual({ id: CAPS_NEW, per_hire_usd: 120, per_week_usd: 500 });
  });

  it("another tenant's caps are not this tenant's caps", async () => {
    seed({ cgo_creator_caps: [caps(CAPS_NEW, OTHER, "120.00", "2026-10-05T00:00:00Z")] });
    expect(await latestCreatorCaps(T)).toBeNull();
  });
});

describe("fileCreatorHireCard (test 4)", () => {
  it("no caps: no card, and the card RPC is never called", async () => {
    seed({ agent_runs: [{ id: RUN, tenant_id: T, channel_slug: "ugc" }] });
    const out = await fileCreatorHireCard(HIRE);
    expect(out).toMatchObject({ ok: false, refusal: "no_caps" });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("over the per-hire cap of the NEWEST caps: no card, message names the cap", async () => {
    seed({
      agent_runs: [{ id: RUN, tenant_id: T, channel_slug: "ugc" }],
      cgo_creator_caps: [caps(CAPS_OLD, T, "100.00", "2026-10-01T00:00:00Z"), caps(CAPS_NEW, T, "54.99", "2026-10-05T00:00:00Z")],
    });
    const out = await fileCreatorHireCard(HIRE);
    expect(out).toMatchObject({ ok: false, refusal: "over_hire_cap" });
    if (!out.ok) expect(out.message).toContain("$54.99");
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("within caps: one creator.hire card with the cost, the Cost row, and the newest caps id", async () => {
    seed({
      agent_runs: [{ id: RUN, tenant_id: T, channel_slug: "ugc" }],
      cgo_creator_caps: [caps(CAPS_OLD, T, "10.00", "2026-10-01T00:00:00Z"), caps(CAPS_NEW, T, "55.00", "2026-10-05T00:00:00Z")],
    });
    const record = vi.fn(async () => ({ id: "card-1" }));
    const out = await fileCreatorHireCard(HIRE, { record });
    expect(out).toEqual({ ok: true, card_id: "card-1" });
    expect(record).toHaveBeenCalledTimes(1);
    const input = (record.mock.calls[0] as unknown as [Record<string, any>])[0];
    expect(input).toMatchObject({
      tenantId: T,
      runId: RUN,
      channelSlug: "ugc",
      execClass: "creator.hire",
      execPayload: { order_id: ORDER, caps_id: CAPS_NEW },
    });
    const cost = "$55.00 ($50.00 + $5.00 Zavi fee), held on your saved card when you approve";
    expect(input.body.cost).toBe(cost);
    expect(input.body.exact_change.rows).toContainEqual({ item: "Cost", before: "Nothing yet", after: cost });
  });

  it("a run that is not a UGC Videos run (the removed Influencers channel included), or not this tenant's, files nothing", async () => {
    seed({
      agent_runs: [
        { id: RUN, tenant_id: T, channel_slug: "meta_ads" },
        { id: "77777777-7777-4777-8777-777777777777", tenant_id: T, channel_slug: "influencer" },
        { id: "88888888-8888-4888-8888-888888888888", tenant_id: OTHER, channel_slug: "ugc" },
      ],
      cgo_creator_caps: [caps(CAPS_NEW, T, "500.00", "2026-10-05T00:00:00Z")],
    });
    const record = vi.fn(async () => ({ id: "card-1" }));
    await expect(fileCreatorHireCard(HIRE, { record })).rejects.toMatchObject({ code: "creator_hire_wrong_run" });
    await expect(fileCreatorHireCard({ ...HIRE, run_id: "88888888-8888-4888-8888-888888888888" }, { record })).rejects.toMatchObject({
      code: "creator_hire_wrong_run",
    });
    await expect(fileCreatorHireCard({ ...HIRE, run_id: "77777777-7777-4777-8777-777777777777" }, { record })).rejects.toMatchObject({
      code: "creator_hire_wrong_run",
    });
    expect(record).not.toHaveBeenCalled();
  });
});

function orderRow(over: Partial<CreatorOrderStateRow> = {}): CreatorOrderStateRow {
  return {
    id: ORDER,
    tenant_id: T,
    human_member_id: "m-1",
    source: "offer",
    status: "checkout_pending",
    closed_reason: null,
    created_at: "2026-10-20T00:00:00Z",
    due_at: null,
    extension_requested_due_at: null,
    extension_state: null,
    next_deadline_at: "2026-10-23T00:00:00Z",
    next_deadline_kind: "checkout_expiry",
    responded_at: null,
    accepted_at: null,
    cancel_requested_at: null,
    status_before_cancel_request: null,
    closed_at: null,
    payout_status: "not_due",
    payout_ready_at: null,
    payout_amount_cents: null,
    price_cents: 5_000,
    business_fee_cents: 500,
    creator_fee_cents: 750,
    business_total_cents: 5_500,
    creator_payout_cents: 4_250,
    package_snapshot: { title: "3 ad videos" },
    livemode: false,
    ...over,
  } as CreatorOrderStateRow;
}

function orderHarness(over: Partial<CreatorOrderStateRow> = {}) {
  let order = orderRow(over);
  const stripe = vi.fn(() => {
    throw new Error("Stripe must not be called");
  });
  const moneyDeps = {
    stripe,
    loadOrder: async () => ({ ...order, stripe_payment_intent_id: null }),
    platformKey: () => "sk_test_x",
    log: async () => {},
  } as unknown as CreatorMoneyDeps;
  const settleHire = vi.fn(async () => ({ status: "released", changed: true }) as const);
  const deps = {
    now: () => new Date("2026-10-21T00:00:00Z"),
    log: async () => {},
    loadOrder: async (tid: string, oid: string) => (tid === order.tenant_id && oid === order.id ? { ...order } : null),
    writeOrder: async ({ expected_status, patch }: { expected_status: string; patch: Record<string, unknown> }) => {
      if (order.status !== expected_status) return null;
      order = { ...order, ...patch } as CreatorOrderStateRow;
      return { ...order };
    },
    latestSubmissionAt: async () => null,
    submissionRounds: async () => 0,
    openDispute: async () => "opened",
    resolveDispute: async () => 1,
    hasOpenDispute: async () => false,
    markMissedDeadline: async () => 1,
    money: {
      capture: vi.fn(),
      cancelHold: vi.fn((a: Parameters<typeof cancelCreatorHold>[0]) => cancelCreatorHold(a, moneyDeps)),
      transfer: vi.fn(),
      refund: vi.fn(),
    },
    notify: { notify: vi.fn(), notifyBothSides: vi.fn(), sendWindowReminder: vi.fn() },
    armDeadline: async () => {},
    armPayoutBuffer: async () => {},
    businessName: async () => "UpcarAI",
    priorCompletedWithCreator: async () => false,
    settleHire,
  } as unknown as CreatorOrderDeps;
  return { deps, stripe, settleHire, row: () => order };
}

describe("declineCreatorHire (test 11)", () => {
  function seedDecline() {
    seed({
      creator_orders: [{ id: ORDER, tenant_id: T, offer_id: OFFER }],
      creator_offers: [
        { id: OFFER, tenant_id: T, status: "accepted", agent_run_id: RUN },
        { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", tenant_id: T, status: "accepted", agent_run_id: null },
      ],
      channel_actions: [
        { id: "card-1", tenant_id: T, exec_class: "creator.hire", status: "pending", exec_payload: { order_id: ORDER, caps_id: CAPS_NEW } },
        { id: "card-2", tenant_id: T, exec_class: "creator.hire", status: "pending", exec_payload: { order_id: "other-order", caps_id: CAPS_NEW } },
        { id: "card-3", tenant_id: OTHER, exec_class: "creator.hire", status: "pending", exec_payload: { order_id: ORDER, caps_id: CAPS_NEW } },
      ],
    });
  }
  const status = (table: string, id: string) => db.tables[table].find((r) => r.id === id)?.status;

  it("cancels the order with no Stripe call, withdraws the accepted agent offer, retires the card, logs the reason", async () => {
    seedDecline();
    const h = orderHarness();
    await declineCreatorHire({ tenant_id: T, order_id: ORDER, reason: "too pricey" }, { orderDeps: h.deps });
    expect(h.row()).toMatchObject({ status: "cancelled", closed_reason: "checkout_abandoned" });
    expect(h.stripe).not.toHaveBeenCalled();
    expect(h.deps.money.capture).not.toHaveBeenCalled();
    expect(h.deps.money.refund).not.toHaveBeenCalled();
    expect(status("creator_offers", OFFER)).toBe("withdrawn");
    expect(status("creator_offers", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toBe("accepted");
    expect(status("channel_actions", "card-1")).toBe("stale");
    expect(status("channel_actions", "card-2")).toBe("pending");
    expect(status("channel_actions", "card-3")).toBe("pending");
    expect(m.log).toHaveBeenCalledWith(
      expect.objectContaining({ code: "creator_hire_declined", tenant_id: T, message: expect.stringContaining("too pricey") }),
    );
  });

  it("a second decline on the closed order is safe and changes nothing", async () => {
    seedDecline();
    const h = orderHarness();
    await declineCreatorHire({ tenant_id: T, order_id: ORDER, reason: "no" }, { orderDeps: h.deps });
    const cancelCalls = (h.deps.money.cancelHold as ReturnType<typeof vi.fn>).mock.calls.length;
    await expect(declineCreatorHire({ tenant_id: T, order_id: ORDER, reason: "no" }, { orderDeps: h.deps })).resolves.toBeUndefined();
    expect((h.deps.money.cancelHold as ReturnType<typeof vi.fn>).mock.calls.length).toBe(cancelCalls);
    expect(h.row().status).toBe("cancelled");
    expect(status("creator_offers", OFFER)).toBe("withdrawn");
    expect(h.stripe).not.toHaveBeenCalled();
  });

  it("a transition that fails for a reason other than already-closed throws, so the caller logs it", async () => {
    seedDecline();
    const transition = vi.fn(async () => ({ ok: false as const, code: "money_needs_staff" as const, message: "x" }));
    await expect(declineCreatorHire({ tenant_id: T, order_id: ORDER, reason: "no" }, { transition })).rejects.toThrow(/money_needs_staff/);
    expect(status("creator_offers", OFFER)).toBe("accepted");
  });
});

describe("declineCreatorHire settles any Checkout before it closes the order (M3)", () => {
  function seedDecline() {
    seed({
      creator_orders: [{ id: ORDER, tenant_id: T, offer_id: OFFER }],
      creator_offers: [{ id: OFFER, tenant_id: T, status: "accepted", agent_run_id: RUN }],
      channel_actions: [
        { id: "card-1", tenant_id: T, exec_class: "creator.hire", status: "pending", exec_payload: { order_id: ORDER, caps_id: CAPS_NEW } },
      ],
    });
  }
  const status = (table: string, id: string) => db.tables[table].find((r) => r.id === id)?.status;

  function settleWorld(opts: { session: string | null; sessionStatus?: "open" | "expired" | "complete"; source?: "offer" | "booking"; fulfilState?: string }) {
    const h = orderHarness();
    const calls: string[] = [];
    const origWrite = (h.deps as unknown as { writeOrder: (a: unknown) => Promise<unknown> }).writeOrder;
    (h.deps as unknown as { writeOrder: (a: unknown) => Promise<unknown> }).writeOrder = async (a) => {
      calls.push("transition");
      return origWrite(a);
    };
    const checkoutRow = () => ({
      id: ORDER,
      tenant_id: T,
      human_member_id: "m-1",
      source: opts.source ?? "offer",
      status: h.row().status,
      booked_by_user_id: null,
      business_total_cents: 5_500,
      currency: "usd",
      livemode: false,
      stripe_checkout_session_id: opts.session,
      stripe_payment_intent_id: null,
      hold_expires_at: null,
      package_snapshot: null,
      offer_id: OFFER,
      agent_run_id: RUN,
    });
    const retrieve = vi.fn(async (id: string) => {
      calls.push(`retrieve:${id}`);
      return { id, status: opts.sessionStatus ?? "open", expires_at: 1_900_000_000 };
    });
    const expire = vi.fn(async (id: string) => {
      calls.push(`expire:${id}`);
      return { id, status: "expired" };
    });
    const stripeClient = vi.fn(() => ({ checkout: { sessions: { retrieve, expire } } }));
    const fulfil = vi.fn(async () =>
      opts.fulfilState
        ? { state: opts.fulfilState, order_id: ORDER, status: "awaiting_acceptance" }
        : { state: "pending", order_id: ORDER, reason: opts.session ? "no_payment_intent" : "no_checkout" },
    );
    const loadOrder = vi.fn(async (tid: string, oid: string) => (tid === T && oid === ORDER ? checkoutRow() : null));
    const settleDeps = {
      fulfil,
      loadOrder,
      stripe: stripeClient,
      keyLivemode: () => false,
      now: () => new Date("2026-10-21T00:00:00Z"),
      log: async () => {},
    } as never;
    return { h, calls, retrieve, expire, stripeClient, fulfil, deps: { orderDeps: h.deps, loadOrder: loadOrder as never, settleDeps } };
  }

  it("an agent order that wrongly has an open session: the session is expired at Stripe BEFORE the checkout_abandoned close", async () => {
    seedDecline();
    const w = settleWorld({ session: "cs_open", sessionStatus: "open" });
    await declineCreatorHire({ tenant_id: T, order_id: ORDER, reason: "no" }, w.deps);
    expect(w.expire).toHaveBeenCalledWith("cs_open");
    expect(w.calls.indexOf("expire:cs_open")).toBeGreaterThanOrEqual(0);
    expect(w.calls.indexOf("expire:cs_open")).toBeLessThan(w.calls.indexOf("transition"));
    expect(w.h.row()).toMatchObject({ status: "cancelled", closed_reason: "checkout_abandoned" });
    expect(status("creator_offers", OFFER)).toBe("withdrawn");
    expect(status("channel_actions", "card-1")).toBe("stale");
  });

  it("a booking-sourced agent order with an open session is expired too, not left to Stripe's own 24h", async () => {
    seedDecline();
    const w = settleWorld({ session: "cs_book", sessionStatus: "open", source: "booking" });
    await declineCreatorHire({ tenant_id: T, order_id: ORDER, reason: "no" }, w.deps);
    expect(w.expire).toHaveBeenCalledWith("cs_book");
    expect(w.calls.indexOf("expire:cs_book")).toBeLessThan(w.calls.indexOf("transition"));
    expect(w.h.row().status).toBe("cancelled");
  });

  it("an already expired session is not expired again, and the order closes", async () => {
    seedDecline();
    const w = settleWorld({ session: "cs_gone", sessionStatus: "expired" });
    await declineCreatorHire({ tenant_id: T, order_id: ORDER, reason: "no" }, w.deps);
    expect(w.expire).not.toHaveBeenCalled();
    expect(w.h.row().status).toBe("cancelled");
  });

  it("no session: no Stripe call at all, and the order closes", async () => {
    seedDecline();
    const w = settleWorld({ session: null });
    await declineCreatorHire({ tenant_id: T, order_id: ORDER, reason: "no" }, w.deps);
    expect(w.stripeClient).not.toHaveBeenCalled();
    expect(w.retrieve).not.toHaveBeenCalled();
    expect(w.expire).not.toHaveBeenCalled();
    expect(w.h.stripe).not.toHaveBeenCalled();
    expect(w.h.row()).toMatchObject({ status: "cancelled", closed_reason: "checkout_abandoned" });
  });

  it("a session already paid at Stripe is never closed: the order stays, the offer is not withdrawn", async () => {
    seedDecline();
    const w = settleWorld({ session: "cs_paid", sessionStatus: "complete" });
    await expect(declineCreatorHire({ tenant_id: T, order_id: ORDER, reason: "no" }, w.deps)).rejects.toThrow(/could not be closed/);
    expect(w.expire).not.toHaveBeenCalled();
    expect(w.calls).not.toContain("transition");
    expect(w.h.row().status).toBe("checkout_pending");
    expect(status("creator_offers", OFFER)).toBe("accepted");
  });

  it("a hold that fulfilment finds behind the order wins: nothing is cancelled or withdrawn", async () => {
    seedDecline();
    const w = settleWorld({ session: "cs_x", fulfilState: "fulfilled" });
    await declineCreatorHire({ tenant_id: T, order_id: ORDER, reason: "no" }, w.deps);
    expect(w.calls).not.toContain("transition");
    expect(w.expire).not.toHaveBeenCalled();
    expect(status("creator_offers", OFFER)).toBe("accepted");
    expect(m.log).toHaveBeenCalledWith(expect.objectContaining({ code: "creator_hire_decline_paid" }));
  });
});

describe("declineCreatorHire after the founder already paid through the Checkout fallback", () => {
  const status = (table: string, id: string) => db.tables[table].find((r) => r.id === id)?.status;

  function world(order: { status: string; closed_reason?: string | null }) {
    seed({
      creator_orders: [{ id: ORDER, tenant_id: T, offer_id: OFFER, status: order.status, closed_reason: order.closed_reason ?? null }],
      creator_offers: [{ id: OFFER, tenant_id: T, status: "accepted", agent_run_id: RUN, updated_at: "2026-10-20T00:00:00Z" }],
      channel_actions: [
        { id: "card-1", tenant_id: T, exec_class: "creator.hire", status: "pending", exec_payload: { order_id: ORDER, caps_id: CAPS_NEW } },
      ],
    });
    const h = orderHarness({ status: order.status, closed_reason: order.closed_reason ?? null } as Partial<CreatorOrderStateRow>);
    const retrieve = vi.fn(async (id: string) => ({ id, status: "open", expires_at: 1_900_000_000 }));
    const expire = vi.fn(async (id: string) => ({ id, status: "expired" }));
    const stripeClient = vi.fn(() => ({ checkout: { sessions: { retrieve, expire } } }));
    const loadOrder = vi.fn(async () => ({
      id: ORDER,
      tenant_id: T,
      human_member_id: "m-1",
      source: "offer",
      status: order.status,
      booked_by_user_id: null,
      business_total_cents: 5_500,
      currency: "usd",
      livemode: false,
      stripe_checkout_session_id: "cs_paid_fallback",
      stripe_payment_intent_id: "pi_paid",
      hold_expires_at: null,
      package_snapshot: null,
      offer_id: OFFER,
      agent_run_id: RUN,
    }));
    const settleDeps = {
      fulfil: vi.fn(),
      loadOrder,
      stripe: stripeClient,
      keyLivemode: () => false,
      now: () => new Date("2026-10-21T00:00:00Z"),
      log: async () => {},
    } as never;
    return { h, expire, stripeClient, deps: { orderDeps: h.deps, loadOrder: loadOrder as never, settleDeps } };
  }

  it("an in_progress order: the running job's offer stays accepted, no Checkout is expired, the order is untouched, no decline is logged", async () => {
    const w = world({ status: "in_progress" });
    await declineCreatorHire({ tenant_id: T, order_id: ORDER, reason: "The founder closed this hire without approving it." }, w.deps);
    expect(status("creator_offers", OFFER)).toBe("accepted");
    expect(db.tables.creator_offers[0].updated_at).toBe("2026-10-20T00:00:00Z");
    expect(w.stripeClient).not.toHaveBeenCalled();
    expect(w.expire).not.toHaveBeenCalled();
    expect(w.h.stripe).not.toHaveBeenCalled();
    expect(w.h.row().status).toBe("in_progress");
    expect(w.h.deps.money.cancelHold).not.toHaveBeenCalled();
    expect(w.h.deps.money.refund).not.toHaveBeenCalled();
    expect(m.log).not.toHaveBeenCalledWith(expect.objectContaining({ code: "creator_hire_declined" }));
    expect(m.log).toHaveBeenCalledWith(expect.objectContaining({ code: "creator_hire_decline_skipped" }));
  });

  it("an order the creator already cancelled for another reason: the offer is not withdrawn", async () => {
    const w = world({ status: "cancelled", closed_reason: "declined" });
    await declineCreatorHire({ tenant_id: T, order_id: ORDER, reason: "no" }, w.deps);
    expect(status("creator_offers", OFFER)).toBe("accepted");
    expect(m.log).not.toHaveBeenCalledWith(expect.objectContaining({ code: "creator_hire_declined" }));
  });

  it("an order already abandoned at checkout still gets its accepted agent offer withdrawn", async () => {
    const w = world({ status: "cancelled", closed_reason: "checkout_abandoned" });
    await declineCreatorHire({ tenant_id: T, order_id: ORDER, reason: "no" }, w.deps);
    expect(status("creator_offers", OFFER)).toBe("withdrawn");
    expect(status("channel_actions", "card-1")).toBe("stale");
    expect(m.log).toHaveBeenCalledWith(expect.objectContaining({ code: "creator_hire_declined" }));
  });
});

describe("retireCreatorHireCards", () => {
  it("only this tenant's pending creator.hire cards for that order go stale", async () => {
    seed({
      channel_actions: [
        { id: "a", tenant_id: T, exec_class: "creator.hire", status: "pending", exec_payload: { order_id: ORDER } },
        { id: "b", tenant_id: T, exec_class: "creator.hire", status: "rejected", exec_payload: { order_id: ORDER } },
        { id: "c", tenant_id: T, exec_class: "generated_video.render.v1", status: "pending", exec_payload: { order_id: ORDER } },
        { id: "d", tenant_id: OTHER, exec_class: "creator.hire", status: "pending", exec_payload: { order_id: ORDER } },
      ],
    });
    expect(await retireCreatorHireCards({ tenant_id: T, order_id: ORDER })).toBe(1);
    expect(db.tables.channel_actions.map((r) => [r.id, r.status])).toEqual([
      ["a", "stale"],
      ["b", "rejected"],
      ["c", "pending"],
      ["d", "pending"],
    ]);
    expect(await retireCreatorHireCards({ tenant_id: T, order_id: ORDER })).toBe(0);
  });
});

describe("the hire card says what approving does", () => {
  const base = {
    tenant_id: "t1",
    run_id: "r1",
    order_id: "o1",
    creator_name: "Maya Films",
    package_title: "1 UGC video",
    business_total_cents: 16_500,
    price_cents: 15_000,
    fee_cents: 1_500,
  };

  it("an accepted offer is charged on approval and never claims the creator still has to accept", () => {
    const card = buildCreatorHireCard({ ...base, source: "offer" });
    const step = (card.body.step as { body: string }).body;
    expect(step).toContain("Maya Films accepted the offer");
    expect(step).toContain("charged to your saved card when you approve");
    expect(step).not.toMatch(/time to accept|hold is released|held on your saved card/);
    expect(card.body.cost).toBe("$165.00 ($150.00 + $15.00 Zavi fee), charged to your saved card when you approve");
  });

  it("a package booking still says the card is held until the creator accepts", () => {
    const step = (buildCreatorHireCard(base).body.step as { body: string }).body;
    expect(step).toContain("held on your saved card when you approve");
    expect(step).toContain("The creator then has time to accept");
  });
});
