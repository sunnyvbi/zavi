
import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { approveCreatorHire, FOUNDER_ONLY, type CreatorHireDeps, type CreatorHireRow } from "../hire-approve";
import { createCreatorSavedCardHold, type CreatorMoneyDeps } from "../orders-money";
import type { CreatorOrderCheckoutRow } from "../booking-db";
import type { CreatorOrderMoneyRow } from "../db";
import type { CreatorHireReserve, CreatorHireSettle } from "@/services/decisions/creator-hire-budget";

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER = "99999999-9999-9999-9999-999999999999";
const ORDER = "22222222-2222-2222-2222-222222222222";
const CREATOR = "33333333-3333-3333-3333-333333333333";
const CAPS = "44444444-4444-4444-4444-444444444444";
const FOUNDER = "55555555-5555-5555-5555-555555555555";

type AnyFn = (...args: any[]) => any;

function world(opts: { reserveAnswer?: CreatorHireReserve["status"]; create?: AnyFn; wallet?: Record<string, unknown> | null } = {}) {
  let order: CreatorOrderCheckoutRow = {
    id: ORDER,
    tenant_id: TENANT,
    human_member_id: CREATOR,
    source: "offer",
    status: "checkout_pending",
    booked_by_user_id: null,
    business_total_cents: 16_500,
    currency: "usd",
    livemode: false,
    stripe_checkout_session_id: null,
    stripe_payment_intent_id: null,
    hold_expires_at: null,
    package_snapshot: { title: "3 ad videos", creator_country_code: "US" },
    offer_id: "o1",
  };
  const money = (): CreatorOrderMoneyRow => ({
    id: order.id,
    tenant_id: order.tenant_id,
    human_member_id: order.human_member_id,
    livemode: order.livemode,
    currency: order.currency,
    price_cents: 15_000,
    business_fee_cents: 1_500,
    creator_fee_cents: 2_250,
    business_total_cents: order.business_total_cents,
    creator_payout_cents: 12_750,
    payout_amount_cents: null,
    status: order.status,
    payout_status: "not_due",
    stripe_checkout_session_id: order.stripe_checkout_session_id,
    stripe_payment_intent_id: order.stripe_payment_intent_id,
    stripe_transfer_id: null,
    hold_expires_at: null,
  });

  const spend = new Map<string, { state: "held" | "spent" | "released" | "refunded"; amount_usd: number }>();
  const reserve = vi.fn(async (tenant_id: string, a: { order_id: string; amount_usd: number; caps_id: string }): Promise<CreatorHireReserve> => {
    if (tenant_id !== order.tenant_id) return { status: "unavailable", error: "order not found for tenant" };
    if (opts.reserveAnswer && opts.reserveAnswer !== "reserved") return { status: opts.reserveAnswer, amount_usd: a.amount_usd } as CreatorHireReserve;
    const row = spend.get(a.order_id);
    if (row && row.state !== "released") return { status: "already_held", amount_usd: row.amount_usd, state: row.state };
    spend.set(a.order_id, { state: "held", amount_usd: a.amount_usd });
    return { status: "reserved", amount_usd: a.amount_usd, left_usd: 1000 };
  });
  const settle = vi.fn(async (_t: string, order_id: string, outcome: "spent" | "released"): Promise<CreatorHireSettle> => {
    const row = spend.get(order_id);
    if (!row) return { status: "not_found" };
    if (row.state === outcome || row.state === "refunded" || (row.state === "spent" && outcome === "released")) return { status: row.state, changed: false };
    row.state = outcome;
    return { status: outcome, changed: true };
  });

  const create = vi.fn<any[], any>(opts.create ?? (async () => ({ id: "pi_saved", status: "requires_capture", amount: 16_500, latest_charge: null })));
  const cancel = vi.fn<any[], any>(async (id: string) => ({ id, status: "canceled" }));
  const stripe = {
    paymentIntents: { create, cancel, retrieve: vi.fn(async (id: string) => ({ id, status: "requires_capture" })) },
    accounts: { retrieve: vi.fn(async () => ({ id: "acct_platform" })) },
  };
  const ads = { accounts: { retrieve: vi.fn(async () => ({ id: "acct_platform" })) } };
  const moneyDeps = {
    stripe: () => stripe as unknown as Stripe,
    adsStripe: () => ads as unknown as Stripe,
    loadOrder: async (t: string, id: string) => (t === order.tenant_id && id === order.id ? money() : null),
    platformKey: () => "sk_test_fake",
  } as unknown as CreatorMoneyDeps;

  const wallets: Record<string, Record<string, unknown> | null> = {
    [TENANT]: opts.wallet === undefined ? { stripe_customer_id: "cus_w", payment_method_id: "pm_w", creator_consent_at: "2026-09-29T00:00:00Z" } : opts.wallet,
    [OTHER]: { stripe_customer_id: "cus_other", payment_method_id: "pm_other", creator_consent_at: "2026-09-29T00:00:00Z" },
  };
  const walletReads: string[] = [];
  const fulfil = vi.fn(async () => {
    if (order.status !== "checkout_pending") return { state: "already_done" as const, order_id: ORDER, status: order.status };
    order = { ...order, status: "in_progress" };
    spend.get(ORDER) && settle(TENANT, ORDER, "spent");
    return { state: "fulfilled" as const, order_id: ORDER, status: "in_progress", payment_intent_id: order.stripe_payment_intent_id!, hold_expires_at: null };
  });
  const resumeCheckout = vi.fn(async () => {
    order = { ...order, stripe_checkout_session_id: "cs_1" };
    return { order_id: ORDER, checkout_url: "https://checkout.stripe/cs_1" };
  });
  const attach = vi.fn(async (a: { tenant_id: string; order_id: string; payment_intent_id: string }) => {
    if (a.tenant_id !== order.tenant_id || order.stripe_payment_intent_id) return false;
    order = { ...order, stripe_payment_intent_id: a.payment_intent_id };
    return true;
  });
  const releaseOrphan = vi.fn(async () => "released" as const);
  const roles: Record<string, string> = { [FOUNDER]: "owner" };

  const deps: Partial<CreatorHireDeps> = {
    roleFor: vi.fn(async (user_id: string, tenant_id: string) => (tenant_id === TENANT ? roles[user_id] ?? null : null)),
    writeEnabled: vi.fn(async () => true),
    loadOrder: async (t, id) => (t === order.tenant_id && id === order.id ? order : null),
    reserve,
    settle,
    loadWallet: async (t) => {
      walletReads.push(t);
      return (wallets[t] ?? null) as never;
    },
    hold: (a, w) => createCreatorSavedCardHold(a, w, moneyDeps),
    attach: attach as never,
    releaseOrphan: releaseOrphan as never,
    fulfil: fulfil as never,
    resumeCheckout: resumeCheckout as never,
  };
  return {
    deps,
    spend,
    create,
    cancel,
    reserve,
    settle,
    fulfil,
    attach,
    releaseOrphan,
    resumeCheckout,
    roles,
    walletReads,
    ads,
    get order() {
      return order;
    },
    setOrder(o: Partial<CreatorOrderCheckoutRow>) {
      order = { ...order, ...o };
    },
  };
}

function card(over: Partial<CreatorHireRow> = {}): CreatorHireRow {
  return {
    id: "ca-1",
    tenant_id: TENANT,
    body: { order_id: ORDER, caps_id: CAPS },
    approved_by: FOUNDER,
    approved_by_source: null,
    exec_source: "channel_actions",
    claim_id: "claim-1",
    ...over,
  };
}

describe("approve within caps and budget (test 1)", () => {
  it("reserves, holds off-session once, attaches the PaymentIntent, fulfils", async () => {
    const w = world();
    const r = await approveCreatorHire(card(), w.deps);
    expect(r.ok).toBe(true);
    expect(w.reserve).toHaveBeenCalledWith(TENANT, {
      order_id: ORDER,
      amount_usd: 165,
      caps_id: CAPS,
      channel_action_id: "ca-1",
      approved_by_user_id: FOUNDER,
    });
    expect(w.create).toHaveBeenCalledTimes(1);
    expect(w.create.mock.calls[0][0]).toMatchObject({ customer: "cus_w", payment_method: "pm_w", off_session: true, confirm: true, capture_method: "manual" });
    expect(w.create.mock.calls[0][0].metadata).toMatchObject({ zavi_creator_order_id: ORDER, zavi_action_id: "ca-1" });
    expect(w.order.stripe_payment_intent_id).toBe("pi_saved");
    expect(w.fulfil).toHaveBeenCalledWith({ tenant_id: TENANT, order_id: ORDER, hold_actor_user_id: FOUNDER });
    expect(w.spend.get(ORDER)?.state).toBe("spent");
  });
});

describe("double approve / retry (test 7)", () => {
  it("two approvals: one reservation, one PaymentIntent", async () => {
    const w = world();
    const a = await approveCreatorHire(card(), w.deps);
    const b = await approveCreatorHire(card(), w.deps);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(w.spend.size).toBe(1);
    expect(w.create).toHaveBeenCalledTimes(1);
    expect(w.fulfil).toHaveBeenCalledTimes(1);
  });

  it("a retry after the hold was attached finishes it without a second hold", async () => {
    const w = world();
    w.fulfil.mockRejectedValueOnce(new Error("crash after attach"));
    const first = await approveCreatorHire(card(), w.deps);
    expect(first).toMatchObject({ ok: false, code: "exec_outcome_unknown" });
    const second = await approveCreatorHire(card(), w.deps);
    expect(second.ok).toBe(true);
    expect(w.create).toHaveBeenCalledTimes(1);
    expect(w.reserve).toHaveBeenCalledTimes(2);
    expect(w.spend.get(ORDER)?.state).toBe("spent");
  });
});

describe("refusals before any Stripe call", () => {
  it.each(["over_hire_cap", "over_week_cap", "over_budget", "no_budget", "no_caps"] as const)("%s: failed with the reason, no Stripe", async (status) => {
    const w = world({ reserveAnswer: status });
    const r = await approveCreatorHire(card(), w.deps);
    expect(r).toMatchObject({ ok: false, code: status });
    expect(w.create).not.toHaveBeenCalled();
    expect(w.ads.accounts.retrieve).not.toHaveBeenCalled();
    expect(w.resumeCheckout).not.toHaveBeenCalled();
  });

  it("kill switch off (test 10): no reserve, no Stripe", async () => {
    const w = world();
    (w.deps.writeEnabled as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const r = await approveCreatorHire(card(), w.deps);
    expect(r).toMatchObject({ ok: false, code: "kill_switch" });
    expect(w.reserve).not.toHaveBeenCalled();
    expect(w.create).not.toHaveBeenCalled();
  });
});

describe("only a founder approves (test 14)", () => {
  it.each([
    ["a cgo approval", { approved_by_source: "cgo" }],
    ["a staff approval", { approved_by_source: "staff" }],
    ["no approver", { approved_by: null }],
    ["a member", { approved_by: "66666666-6666-6666-6666-666666666666" }],
    ["the decisions rail", { exec_source: undefined }],
    ["no claim", { claim_id: null }],
  ])("refuses %s before anything moves", async (_label, over) => {
    const w = world();
    w.roles["66666666-6666-6666-6666-666666666666"] = "member";
    const r = await approveCreatorHire(card(over as Partial<CreatorHireRow>), w.deps);
    expect(r.ok).toBe(false);
    expect(w.reserve).not.toHaveBeenCalled();
    expect(w.create).not.toHaveBeenCalled();
    if (over && "approved_by" in over) expect(r.error).toBe(FOUNDER_ONLY);
  });

  it("an admin may approve", async () => {
    const w = world();
    w.roles[FOUNDER] = "admin";
    expect((await approveCreatorHire(card(), w.deps)).ok).toBe(true);
  });

  it("an unreadable role refuses", async () => {
    const w = world();
    (w.deps.roleFor as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db"));
    expect(await approveCreatorHire(card(), w.deps)).toMatchObject({ ok: false, code: "creator_hire_role_unavailable" });
    expect(w.reserve).not.toHaveBeenCalled();
  });
});

describe("cross-tenant (test 9)", () => {
  it("a card for another tenant cannot reach this tenant's order or charge any card", async () => {
    const w = world();
    (w.deps.roleFor as ReturnType<typeof vi.fn>).mockResolvedValue("owner");
    const r = await approveCreatorHire(card({ tenant_id: OTHER }), w.deps);
    expect(r).toMatchObject({ ok: false, code: "creator_order_not_found" });
    expect(w.reserve).not.toHaveBeenCalled();
    expect(w.walletReads).toEqual([]);
    expect(w.create).not.toHaveBeenCalled();
  });

  it("the card charged is always the approving tenant's own wallet", async () => {
    const w = world();
    await approveCreatorHire(card(), w.deps);
    expect(w.walletReads).toEqual([TENANT]);
  });
});

describe("falls back to Checkout, reservation kept held while the link is payable", () => {
  it("3DS (test 6): cancels the PaymentIntent, keeps the reservation held, returns the Checkout link", async () => {
    const w = world({ create: async () => ({ id: "pi_3ds", status: "requires_action", amount: 16_500 }) });
    const r = await approveCreatorHire(card(), w.deps);
    expect(r).toMatchObject({ ok: false, code: "creator_hire_checkout", checkout_url: "https://checkout.stripe/cs_1" });
    expect(w.cancel).toHaveBeenCalledWith("pi_3ds", {}, { idempotencyKey: "cr-orphan-pi_3ds" });
    expect(w.spend.get(ORDER)?.state).toBe("held");
    expect(w.order.stripe_payment_intent_id).toBeNull();
    expect(w.fulfil).not.toHaveBeenCalled();
  });

  it("confirm throws with the PaymentIntent in the error (test 17)", async () => {
    const w = world({
      create: async () => {
        throw Object.assign(new Error("declined"), { type: "StripeCardError", payment_intent: { id: "pi_err", status: "requires_payment_method" } });
      },
    });
    const r = await approveCreatorHire(card(), w.deps);
    expect(r).toMatchObject({ ok: false, code: "creator_hire_checkout", checkout_url: "https://checkout.stripe/cs_1" });
    expect(w.cancel).toHaveBeenCalledWith("pi_err", {}, { idempotencyKey: "cr-orphan-pi_err" });
    expect(w.order.stripe_payment_intent_id).toBeNull();
    expect(w.spend.get(ORDER)?.state).toBe("held");
  });

  it("stripe account mismatch (test 12): no charge, Checkout", async () => {
    const w = world();
    w.ads.accounts.retrieve.mockResolvedValue({ id: "acct_other" });
    const r = await approveCreatorHire(card(), w.deps);
    expect(r).toMatchObject({ ok: false, code: "creator_hire_checkout" });
    expect(w.create).not.toHaveBeenCalled();
    expect(w.spend.get(ORDER)?.state).toBe("held");
  });

  it.each([
    ["no wallet", null],
    ["no saved card", { stripe_customer_id: "cus_w", payment_method_id: null, creator_consent_at: "2026-09-29T00:00:00Z" }],
    ["a card saved before the widened consent (test 18)", { stripe_customer_id: "cus_w", payment_method_id: "pm_w", creator_consent_at: null }],
  ])("%s (test 12/18): no charge, Checkout", async (_label, wallet) => {
    const w = world({ wallet });
    const r = await approveCreatorHire(card(), w.deps);
    expect(r).toMatchObject({ ok: false, code: "creator_hire_checkout", checkout_url: "https://checkout.stripe/cs_1" });
    expect(w.create).not.toHaveBeenCalled();
    expect(w.spend.get(ORDER)?.state).toBe("held");
  });

  it("codex F1: the budget a payable Checkout still needs cannot be spent by another hire", async () => {
    const w = world({ create: async () => ({ id: "pi_3ds", status: "requires_action", amount: 16_500 }) });
    const r = await approveCreatorHire(card(), w.deps);
    expect(r).toMatchObject({ code: "creator_hire_checkout" });
    expect(w.spend.get(ORDER)).toEqual({ state: "held", amount_usd: 165 });
    expect(w.settle).not.toHaveBeenCalledWith(TENANT, ORDER, "released");
  });

  it("codex F1: no Checkout could be opened here: the reservation stays held (another tab may attach one); the close releases it", async () => {
    const w = world({ wallet: null });
    w.resumeCheckout.mockRejectedValueOnce(new Error("stripe down"));
    const r = await approveCreatorHire(card(), w.deps);
    expect(r).toMatchObject({ ok: false, code: "creator_hire_checkout_unavailable" });
    expect(w.spend.get(ORDER)?.state).toBe("held");
    expect(w.settle).not.toHaveBeenCalledWith(TENANT, ORDER, "released");
  });

  it("a second approve after the fallback stays on Checkout: no reserve, no charge", async () => {
    const w = world({ wallet: null });
    await approveCreatorHire(card(), w.deps);
    w.reserve.mockClear();
    const again = await approveCreatorHire(card(), w.deps);
    expect(again).toMatchObject({ code: "creator_hire_checkout" });
    expect(w.reserve).not.toHaveBeenCalled();
    expect(w.create).not.toHaveBeenCalled();
  });

  it("an ambiguous failure is asked again once with the same key; a held answer carries on (F3)", async () => {
    let calls = 0;
    const w = world({
      create: async () => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error("socket"), { type: "StripeConnectionError" });
        return { id: "pi_saved", status: "requires_capture", amount: 16_500, latest_charge: null };
      },
    });
    const r = await approveCreatorHire(card(), w.deps);
    expect(r.ok).toBe(true);
    expect(w.create).toHaveBeenCalledTimes(2);
    expect(w.create.mock.calls.map((c) => c[1])).toEqual([
      { idempotencyKey: `cr-saved-hold-${ORDER}` },
      { idempotencyKey: `cr-saved-hold-${ORDER}` },
    ]);
    expect(w.order.stripe_payment_intent_id).toBe("pi_saved");
  });

  it("an unconfirmed cancel of a declined hold keeps the reservation and opens no Checkout (F4)", async () => {
    const w = world({ create: async () => ({ id: "pi_3ds", status: "requires_action", amount: 16_500 }) });
    w.cancel.mockRejectedValue(new Error("network"));
    const r = await approveCreatorHire(card(), w.deps);
    expect(r).toMatchObject({ ok: false, code: "exec_outcome_unknown" });
    expect(w.spend.get(ORDER)?.state).toBe("held");
    expect(w.resumeCheckout).not.toHaveBeenCalled();
  });

  it("review F2: a Checkout paid in another tab meanwhile keeps the reservation held", async () => {
    const w = world({ wallet: null });
    w.resumeCheckout.mockImplementationOnce(async () => {
      w.setOrder({ stripe_checkout_session_id: "cs_other", stripe_payment_intent_id: "pi_other" });
      throw new Error("checkout_already_paid");
    });
    const r = await approveCreatorHire(card(), w.deps);
    expect(r).toMatchObject({ ok: false, code: "creator_hire_checkout_unavailable" });
    expect(w.spend.get(ORDER)?.state).toBe("held");
  });

  it("a retry after the link failed to open reuses the held reservation and opens the link", async () => {
    const w = world({ wallet: null });
    w.resumeCheckout.mockRejectedValueOnce(new Error("stripe down"));
    await approveCreatorHire(card(), w.deps);
    const again = await approveCreatorHire(card(), w.deps);
    expect(again).toMatchObject({ ok: false, code: "creator_hire_checkout", checkout_url: "https://checkout.stripe/cs_1" });
    expect(w.spend.size).toBe(1);
    expect(w.spend.get(ORDER)?.state).toBe("held");
  });

  it("an ambiguous Stripe failure keeps the reservation and opens nothing beside it", async () => {
    const w = world({ create: async () => { throw Object.assign(new Error("socket"), { type: "StripeConnectionError" }); } });
    const r = await approveCreatorHire(card(), w.deps);
    expect(r).toMatchObject({ ok: false, code: "exec_outcome_unknown" });
    expect(w.spend.get(ORDER)?.state).toBe("held");
    expect(w.resumeCheckout).not.toHaveBeenCalled();
  });
});

describe("attach race", () => {
  it("another payment landed first: this hold is cancelled and the reservation released", async () => {
    const w = world();
    w.attach.mockImplementationOnce(async () => {
      w.setOrder({ stripe_payment_intent_id: "pi_checkout" });
      return false;
    });
    const r = await approveCreatorHire(card(), w.deps);
    expect(r).toMatchObject({ ok: false, code: "creator_hire_order_changed" });
    expect(w.releaseOrphan).toHaveBeenCalledWith({ payment_intent_id: "pi_saved", order_livemode: false });
    expect(w.spend.get(ORDER)?.state).toBe("released");
    expect(w.fulfil).not.toHaveBeenCalled();
  });

  it.each([["not_held"]] as const)("codex F2: the orphan answers %s: released", async (answer) => {
    const w = world();
    w.attach.mockImplementationOnce(async () => {
      w.setOrder({ stripe_payment_intent_id: "pi_checkout" });
      return false;
    });
    w.releaseOrphan.mockResolvedValueOnce(answer as never);
    expect(await approveCreatorHire(card(), w.deps)).toMatchObject({ ok: false, code: "creator_hire_order_changed" });
    expect(w.spend.get(ORDER)?.state).toBe("released");
  });

  it("codex F2: the orphan was already captured: the reservation is spent, never released", async () => {
    const w = world();
    w.attach.mockImplementationOnce(async () => {
      w.setOrder({ stripe_payment_intent_id: "pi_checkout" });
      return false;
    });
    w.releaseOrphan.mockResolvedValueOnce("captured" as never);
    const r = await approveCreatorHire(card(), w.deps);
    expect(r).toMatchObject({ ok: false, code: "exec_outcome_unknown" });
    expect(w.spend.get(ORDER)?.state).toBe("spent");
    expect(w.settle).not.toHaveBeenCalledWith(TENANT, ORDER, "released");
  });

  it("codex F2: cancelling the orphan throws: the reservation stays held", async () => {
    const w = world();
    w.attach.mockImplementationOnce(async () => {
      w.setOrder({ stripe_payment_intent_id: "pi_checkout" });
      return false;
    });
    w.releaseOrphan.mockRejectedValueOnce(new Error("stripe down"));
    const r = await approveCreatorHire(card(), w.deps);
    expect(r).toMatchObject({ ok: false, code: "exec_outcome_unknown" });
    expect(w.spend.get(ORDER)?.state).toBe("held");
    expect(w.fulfil).not.toHaveBeenCalled();
  });

  it("a lost attach reply for this same PaymentIntent carries on", async () => {
    const w = world();
    w.attach.mockImplementationOnce(async () => {
      w.setOrder({ stripe_payment_intent_id: "pi_saved" });
      throw new Error("reply lost");
    });
    expect((await approveCreatorHire(card(), w.deps)).ok).toBe(true);
    expect(w.releaseOrphan).not.toHaveBeenCalled();
    expect(w.fulfil).toHaveBeenCalledTimes(1);
  });
});

describe("what the founder reads", () => {
  it("a booking is held, not charged, until the creator accepts", async () => {
    const w = world();
    w.fulfil.mockImplementationOnce(async () => ({ state: "fulfilled", order_id: ORDER, status: "awaiting_acceptance", payment_intent_id: "pi_saved", hold_expires_at: null }) as never);
    expect((await approveCreatorHire(card(), w.deps)).notice).toMatch(/held until the creator accepts/);
  });

  it("an internal error never reaches the card; a typed refusal does", async () => {
    const w = world();
    w.deps.loadWallet = async () => { throw new Error("ads wallet read failed: relation secret_table does not exist"); };
    const r = await approveCreatorHire(card(), w.deps);
    expect(r.error).toBe("Zavi could not start this payment. Nothing was charged.");
    expect(w.spend.get(ORDER)?.state).toBe("released");
  });
});

describe("the order is past payment", () => {
  it("an order that is cancelled is refused with no Stripe call", async () => {
    const w = world();
    w.setOrder({ status: "cancelled" });
    expect(await approveCreatorHire(card(), w.deps)).toMatchObject({ ok: false, code: "creator_order_not_awaiting_checkout" });
    expect(w.reserve).not.toHaveBeenCalled();
    expect(w.create).not.toHaveBeenCalled();
  });
});

describe("the hire's own deadline (M6)", () => {
  const NOW = new Date("2026-10-22T12:00:00.000Z");

  it("a deadline already past refuses with no reserve, no wallet read, no Stripe and no Checkout, before the sweep closes it", async () => {
    const w = world();
    w.setOrder({ next_deadline_at: "2026-10-22T11:59:59.000Z" });
    const r = await approveCreatorHire(card(), { ...w.deps, now: () => NOW });
    expect(r).toMatchObject({ ok: false, code: "creator_hire_expired" });
    expect(r.error).toMatch(/nothing was charged/i);
    expect(w.reserve).not.toHaveBeenCalled();
    expect(w.walletReads).toEqual([]);
    expect(w.create).not.toHaveBeenCalled();
    expect(w.resumeCheckout).not.toHaveBeenCalled();
    expect(w.fulfil).not.toHaveBeenCalled();
    expect(w.order.status).toBe("checkout_pending");
  });

  it("exactly at the deadline is already too late", async () => {
    const w = world();
    w.setOrder({ next_deadline_at: NOW.toISOString() });
    expect(await approveCreatorHire(card(), { ...w.deps, now: () => NOW })).toMatchObject({ code: "creator_hire_expired" });
    expect(w.create).not.toHaveBeenCalled();
  });

  it("a passed deadline with a Checkout already handed out still opens nothing", async () => {
    const w = world();
    w.setOrder({ next_deadline_at: "2026-10-21T00:00:00.000Z", stripe_checkout_session_id: "cs_old" });
    expect(await approveCreatorHire(card(), { ...w.deps, now: () => NOW })).toMatchObject({ code: "creator_hire_expired" });
    expect(w.resumeCheckout).not.toHaveBeenCalled();
  });

  it("a deadline still ahead approves as normal", async () => {
    const w = world();
    w.setOrder({ next_deadline_at: "2026-10-22T12:00:01.000Z" });
    const r = await approveCreatorHire(card(), { ...w.deps, now: () => NOW });
    expect(r.ok).toBe(true);
    expect(w.create).toHaveBeenCalledTimes(1);
  });

  it("a retry whose hold is already attached is finished, not refused, even past the deadline", async () => {
    const w = world();
    w.setOrder({ next_deadline_at: "2026-10-21T00:00:00.000Z", stripe_payment_intent_id: "pi_saved" });
    const r = await approveCreatorHire(card(), { ...w.deps, now: () => NOW });
    expect(r.code).not.toBe("creator_hire_expired");
    expect(w.create).not.toHaveBeenCalled();
    expect(w.fulfil).toHaveBeenCalledTimes(1);
  });
});
