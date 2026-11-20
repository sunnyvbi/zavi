import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TENANT = "aaaaaaaa-0000-4000-8000-000000000001";
const CREATOR = "55555555-0000-4000-8000-000000000055";
const RUN = "99999999-0000-4000-8000-000000000099";
const OWNER = "33333333-0000-4000-8000-000000000033";

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
let seq = 0;
const nextId = () => `f0000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

function query(table: string, tid: string | null, op: "select" | "insert" | "update", payload?: Row) {
  const filters: Array<[string, unknown]> = [];
  let single = false;
  const matched = () =>
    (db[table] ?? []).filter((r) => (tid === null || r.tenant_id === tid) && filters.every(([k, v]) => r[k] === v));
  const run = () => {
    if (op === "select") {
      const rows = matched();
      return { data: single ? (rows[0] ?? null) : rows, error: null };
    }
    if (op === "insert") {
      const row: Row = { created_at: new Date().toISOString(), ...payload, id: nextId(), tenant_id: tid };
      (db[table] ??= []).push(row);
      return { data: single ? row : [row], error: null };
    }
    const hits = matched();
    for (const r of hits) Object.assign(r, payload ?? {});
    return { data: single ? (hits[0] ?? null) : hits, error: null };
  };
  const q: Record<string, unknown> = {};
  Object.assign(q, {
    eq(k: string, v: unknown) {
      filters.push([k, v]);
      return q;
    },
    order: () => q,
    limit: () => q,
    not: () => q,
    select: () => q,
    maybeSingle() {
      single = true;
      return q;
    },
    then(onF?: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
      return Promise.resolve(run()).then(onF as never, onR as never);
    },
  });
  return q;
}

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantClient: (tid: string) => ({
    from: (table: string) => ({
      select: () => query(table, tid, "select"),
      insert: (row: Row) => query(table, tid, "insert", row),
      update: (row: Row) => query(table, tid, "update", row),
    }),
  }),
  globalClient: () => ({
    from: (table: string) => {
      if (table !== "human_members") throw new Error(`globalClient: '${table}' is not global`);
      return { select: () => query(table, null, "select") };
    },
  }),
  preTenantRpc: () => {
    throw new Error("not used");
  },
}));

const notifyCalls: Array<Record<string, unknown>> = [];
vi.mock("@/services/creators/notify", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/services/creators/notify")>();
  return {
    ...real,
    notify: vi.fn(async (input: Record<string, unknown>) => {
      notifyCalls.push(input);
      return { written: true, emailed: true, notification_id: "n1", dedupe_key: "" };
    }),
  };
});

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));

const checkoutCalls: Array<Record<string, unknown>> = [];
const stripeSessionsOpened: string[] = [];
vi.mock("../booking", () => ({
  startCreatorCheckout: vi.fn(async (args: Record<string, unknown>) => {
    checkoutCalls.push(args);
    const target = args.target as { offer_id: string };
    const existing = db.creator_orders.find((o) => o.offer_id === target.offer_id);
    if (existing) {
      return { order_id: existing.id, checkout_session_id: existing.session ?? null, checkout_url: existing.url ?? null, reused_existing: true };
    }
    const order: Row = { id: nextId(), tenant_id: args.tenant_id, offer_id: target.offer_id, status: "checkout_pending" };
    if (args.initiator !== "agent") {
      order.session = `cs_${order.id}`;
      order.url = `https://checkout.stripe.com/c/${order.id}`;
      stripeSessionsOpened.push(order.session as string);
    }
    db.creator_orders.push(order);
    return { order_id: order.id, checkout_session_id: order.session ?? null, checkout_url: order.url ?? null, reused_existing: false };
  }),
}));

const fileCard = vi.fn();
const declineHire = vi.fn();
const caps = vi.hoisted(() => ({ value: { id: "caps-1", per_hire_usd: 100, per_week_usd: 300 } as { id: string; per_hire_usd: number; per_week_usd: number } | null }));
vi.mock("@/services/decisions/creator-hire-budget", () => ({ latestCreatorCaps: async () => caps.value }));
vi.mock("../hire-card", () => ({
  fileCreatorHireCard: (...a: unknown[]) => fileCard(...a),
  declineCreatorHire: (...a: unknown[]) => declineHire(...a),
}));

import { __setCreatorMoneyPortForTest } from "../money-port";
import { wireCreatorMoneyPort } from "../offer-money-port";
import { acceptCreatorOffer, createCreatorOffer, HIRE_REFUSED_MESSAGE } from "../offers";

const CREATOR_ACCESS = { tenant_id: TENANT, sender_kind: "creator" as const, human_member_id: CREATOR };

async function sendOffer(agent_run_id: string | null) {
  const thread: Row = { id: nextId(), tenant_id: TENANT, human_member_id: CREATOR };
  db.creator_threads.push(thread);
  return createCreatorOffer({
    tenant_id: TENANT,
    human_member_id: CREATOR,
    proposed_by: "tenant",
    proposed_by_user_id: agent_run_id ? null : OWNER,
    agent_run_id,
    thread_id: thread.id as string,
    kind: "ugc_video",
    terms: { title: "Two unboxing videos", video_count: 2 },
    price_cents: 5000,
    delivery_days: 7,
  });
}

function paymentLinkEmails() {
  return notifyCalls.filter((c) => c.event === "custom_offer_accepted");
}

beforeEach(() => {
  caps.value = { id: "caps-1", per_hire_usd: 100, per_week_usd: 300 };
  seq = 0;
  db.human_members = [{ id: CREATOR, display_name: "Maya Lens" }];
  db.creator_threads = [];
  db.creator_offers = [];
  db.creator_orders = [];
  db.tenants = [{ id: TENANT, tenant_id: TENANT, display_name: "Acme" }];
  notifyCalls.length = 0;
  checkoutCalls.length = 0;
  stripeSessionsOpened.length = 0;
  fileCard.mockReset();
  declineHire.mockReset();
  fileCard.mockResolvedValue({ ok: true, card_id: "card-1" });
  declineHire.mockResolvedValue(undefined);
  __setCreatorMoneyPortForTest(null);
  wireCreatorMoneyPort();
});

afterEach(() => {
  __setCreatorMoneyPortForTest(null);
});

describe("agent offer: proposed by a run, held for the founder's card approval", () => {
  it("stores the run on the offer with no proposing user", async () => {
    const offer = await sendOffer(RUN);
    expect(db.creator_offers[0]).toMatchObject({ id: offer.id, agent_run_id: RUN, proposed_by_user_id: null, proposed_by: "tenant" });
    expect(offer.agent_run_id).toBe(RUN);
  });

  it("refuses a run on a creator-proposed offer before any row is written", async () => {
    await expect(
      createCreatorOffer({
        tenant_id: TENANT,
        human_member_id: CREATOR,
        proposed_by: "creator",
        proposed_by_user_id: null,
        agent_run_id: RUN,
        thread_id: "th",
        kind: "ugc_video",
        terms: {},
        price_cents: 5000,
        delivery_days: 7,
      }),
    ).rejects.toThrow(/agent run/);
    expect(db.creator_offers).toHaveLength(0);
  });

  it("accept opens no Checkout, sends no payment-link email, and files one card for the run and order", async () => {
    const offer = await sendOffer(RUN);
    notifyCalls.length = 0;

    const result = await acceptCreatorOffer({ access: CREATOR_ACCESS, offer_id: offer.id });

    expect(result.ok).toBe(true);
    expect(checkoutCalls).toHaveLength(1);
    expect(checkoutCalls[0]).toMatchObject({ initiator: "agent", agent_run_id: RUN, user_id: null, offer_already_claimed: true, target: { source: "offer", offer_id: offer.id } });
    expect(checkoutCalls[0]).not.toHaveProperty("success_url");
    expect(checkoutCalls[0]).not.toHaveProperty("cancel_url");
    expect(stripeSessionsOpened).toEqual([]);
    expect(paymentLinkEmails()).toEqual([]);
    expect(notifyCalls).toEqual([]);

    const order = db.creator_orders[0];
    expect(fileCard).toHaveBeenCalledTimes(1);
    expect(fileCard.mock.calls[0][0]).toEqual({
      tenant_id: TENANT,
      run_id: RUN,
      order_id: order.id,
      creator_name: "Maya Lens",
      package_title: "Two unboxing videos",
      business_total_cents: 5500,
      price_cents: 5000,
      fee_cents: 500,
      source: "offer",
    });
    expect(declineHire).not.toHaveBeenCalled();
    expect(db.creator_offers[0].status).toBe("accepted");
    if (result.ok) expect(result.order).toMatchObject({ order_id: order.id, checkout_url: null, already_existed: false });
  });

  it("a replayed accept makes no second order or Checkout, and re-files the card for the SAME order so a lost first card is recovered", async () => {
    const offer = await sendOffer(RUN);
    await acceptCreatorOffer({ access: CREATOR_ACCESS, offer_id: offer.id });
    const again = await acceptCreatorOffer({ access: CREATOR_ACCESS, offer_id: offer.id });
    expect(again.ok).toBe(true);
    expect(db.creator_orders).toHaveLength(1);
    expect(checkoutCalls).toHaveLength(1);
    expect(stripeSessionsOpened).toEqual([]);
    expect(fileCard).toHaveBeenCalledTimes(2);
    expect(fileCard.mock.calls[1][0]).toEqual(fileCard.mock.calls[0][0]);
  });

  it("an agent offer over the per-hire cap at accept creates no order and no card, and withdraws the offer", async () => {
    const offer = await sendOffer(RUN);
    caps.value = { id: "caps-2", per_hire_usd: 40, per_week_usd: 300 };
    const result = await acceptCreatorOffer({ access: CREATOR_ACCESS, offer_id: offer.id });
    expect(result).toEqual({ ok: false, code: "hire_refused", refusal: "over_hire_cap", message: HIRE_REFUSED_MESSAGE });
    expect(checkoutCalls).toEqual([]);
    expect(db.creator_orders).toEqual([]);
    expect(fileCard).not.toHaveBeenCalled();
    expect(db.creator_offers[0].status).toBe("withdrawn");
  });

  it("an agent offer with no caps at accept creates no order", async () => {
    const offer = await sendOffer(RUN);
    caps.value = null;
    const result = await acceptCreatorOffer({ access: CREATOR_ACCESS, offer_id: offer.id });
    expect(result).toMatchObject({ ok: false, code: "hire_refused", refusal: "no_caps" });
    expect(db.creator_orders).toEqual([]);
  });

  it("a refused card declines the order and tells the creator plainly, still with no Checkout or email", async () => {
    fileCard.mockResolvedValue({ ok: false, refusal: "over_hire_cap", message: "Over your $40.00 per-hire cap." });
    const offer = await sendOffer(RUN);
    notifyCalls.length = 0;

    const result = await acceptCreatorOffer({ access: CREATOR_ACCESS, offer_id: offer.id });

    expect(result).toEqual({ ok: false, code: "hire_refused", refusal: "over_hire_cap", message: HIRE_REFUSED_MESSAGE });
    expect(declineHire).toHaveBeenCalledTimes(1);
    expect(declineHire.mock.calls[0][0]).toEqual({
      tenant_id: TENANT,
      order_id: db.creator_orders[0].id,
      reason: "Over your $40.00 per-hire cap.",
    });
    expect(stripeSessionsOpened).toEqual([]);
    expect(notifyCalls).toEqual([]);
  });

  it("a card that cannot be filed declines the order and fails the accept", async () => {
    fileCard.mockRejectedValue(new Error("channel_actions insert failed"));
    const offer = await sendOffer(RUN);
    await expect(acceptCreatorOffer({ access: CREATOR_ACCESS, offer_id: offer.id })).rejects.toThrow(/channel_actions/);
    expect(declineHire).toHaveBeenCalledTimes(1);
    expect(declineHire.mock.calls[0][0]).toMatchObject({ tenant_id: TENANT, order_id: db.creator_orders[0].id });
    expect(stripeSessionsOpened).toEqual([]);
  });
});

describe("human offer accept is unchanged", () => {
  it("opens Checkout with return urls, emails the business the payment link, and files no card", async () => {
    const offer = await sendOffer(null);
    notifyCalls.length = 0;

    const result = await acceptCreatorOffer({ access: CREATOR_ACCESS, offer_id: offer.id });

    expect(result.ok).toBe(true);
    expect(checkoutCalls).toHaveLength(1);
    expect(checkoutCalls[0].initiator).toBeUndefined();
    expect(checkoutCalls[0].agent_run_id).toBeUndefined();
    expect(checkoutCalls[0]).toMatchObject({ large_amount_confirmed: true, offer_already_claimed: true });
    expect(String(checkoutCalls[0].success_url)).toContain("paid=1");
    expect(String(checkoutCalls[0].cancel_url)).toContain("cancelled=1");
    const order = db.creator_orders[0];
    expect(stripeSessionsOpened).toEqual([`cs_${order.id}`]);
    const emails = paymentLinkEmails();
    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatchObject({
      recipient: { kind: "tenant", tenant_id: TENANT },
      order_id: order.id,
      email_cta_url: `https://checkout.stripe.com/c/${order.id}`,
    });
    expect(fileCard).not.toHaveBeenCalled();
    expect(declineHire).not.toHaveBeenCalled();
  });
});
