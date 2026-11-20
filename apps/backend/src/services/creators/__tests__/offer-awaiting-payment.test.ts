
import { describe, expect, it, vi } from "vitest";

const NOW = new Date("2026-09-27T12:00:00.000Z");
const later = "2026-09-28T12:00:00.000Z";
const earlier = "2026-09-26T12:00:00.000Z";

const offers = [
  { id: "unpaid", status: "accepted", expires_at: later },
  { id: "paid", status: "accepted", expires_at: later },
  { id: "no-order", status: "accepted", expires_at: later },
  { id: "lapsed", status: "accepted", expires_at: earlier },
  { id: "abandoned", status: "accepted", expires_at: later },
  { id: "paid-then-expired", status: "accepted", expires_at: earlier },
  { id: "open", status: "open", expires_at: later },
].map((o) => ({ ...o, tenant_id: "t1", human_member_id: "m1", thread_id: "th1", proposed_by: "creator", kind: "ugc_video", terms: {}, price_cents: 10_000, currency: "usd", delivery_days: 3, note: null, responded_at: null, created_at: earlier }));
const orders = [
  { offer_id: "unpaid", status: "checkout_pending", closed_reason: null },
  { offer_id: "paid", status: "in_progress", closed_reason: null },
  { offer_id: "abandoned", status: "cancelled", closed_reason: "checkout_abandoned" },
  { offer_id: "paid-then-expired", status: "completed", closed_reason: "approved" },
];
const orderQueries: unknown[][] = [];

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order", "limit"]) q[m] = () => q;
      q.in = (...args: unknown[]) => {
        orderQueries.push(args);
        return Promise.resolve({ data: orders, error: null });
      };
      q.then = (resolve: (v: unknown) => unknown) => resolve({ data: table === "creator_offers" ? offers : [], error: null });
      return q;
    },
  }),
}));

import { listThreadOffers } from "../offers";

describe("thread offers: awaiting_payment", () => {
  it("is true only for an accepted, unexpired offer whose order has not been paid", async () => {
    const views = await listThreadOffers({ tenant_id: "t1", thread_id: "th1", now: NOW });
    const by = Object.fromEntries(views.map((v) => [v.id, v.awaiting_payment]));
    expect(by).toEqual({
      unpaid: true,
      paid: false,
      "no-order": true,
      lapsed: false,
      abandoned: false,
      "paid-then-expired": false,
      open: false,
    });
    expect(orderQueries).toEqual([["offer_id", ["unpaid", "paid", "no-order", "lapsed", "abandoned", "paid-then-expired"]]]);
  });

  it("closed_unpaid marks an accepted offer that expired or closed before anyone paid", async () => {
    const views = await listThreadOffers({ tenant_id: "t1", thread_id: "th1", now: NOW });
    const by = Object.fromEntries(views.map((v) => [v.id, v.closed_unpaid]));
    expect(by).toEqual({
      unpaid: false,
      paid: false,
      "no-order": false,
      lapsed: true,
      abandoned: true,
      "paid-then-expired": false,
      open: false,
    });
  });
});

describe("thread offers: an agent offer waits for the hire card, never a Pay button (M2)", () => {
  it("an accepted unpaid agent offer has no awaiting_payment at all and reports awaiting_approval", async () => {
    const extra = [
      { id: "agent-unpaid", agent_run_id: "run-1", expires_at: later },
      { id: "agent-no-order", agent_run_id: "run-1", expires_at: later },
      { id: "agent-paid", agent_run_id: "run-1", expires_at: later },
      { id: "agent-declined", agent_run_id: "run-1", expires_at: later },
      { id: "agent-lapsed", agent_run_id: "run-1", expires_at: earlier },
    ].map((o) => ({ ...offers[0], ...o }));
    offers.push(...extra);
    orders.push(
      { offer_id: "agent-unpaid", status: "checkout_pending", closed_reason: null },
      { offer_id: "agent-paid", status: "awaiting_acceptance", closed_reason: null },
      { offer_id: "agent-declined", status: "cancelled", closed_reason: "checkout_abandoned" },
    );
    try {
      const views = await listThreadOffers({ tenant_id: "t1", thread_id: "th1", now: NOW });
      const pick = (id: string) => {
        const v = views.find((x) => x.id === id)!;
        return { has_awaiting_payment: "awaiting_payment" in v, awaiting_payment: v.awaiting_payment, awaiting_approval: v.awaiting_approval, closed_unpaid: v.closed_unpaid };
      };
      expect(pick("agent-unpaid")).toEqual({ has_awaiting_payment: false, awaiting_payment: undefined, awaiting_approval: true, closed_unpaid: false });
      expect(pick("agent-no-order")).toEqual({ has_awaiting_payment: false, awaiting_payment: undefined, awaiting_approval: true, closed_unpaid: false });
      expect(pick("agent-paid")).toEqual({ has_awaiting_payment: true, awaiting_payment: false, awaiting_approval: false, closed_unpaid: false });
      expect(pick("agent-declined")).toEqual({ has_awaiting_payment: true, awaiting_payment: false, awaiting_approval: false, closed_unpaid: true });
      expect(pick("agent-lapsed")).toEqual({ has_awaiting_payment: true, awaiting_payment: false, awaiting_approval: false, closed_unpaid: true });
      expect(JSON.parse(JSON.stringify(views.find((x) => x.id === "agent-unpaid")))).not.toHaveProperty("awaiting_payment");
      expect(views.find((x) => x.id === "unpaid")).toMatchObject({ awaiting_payment: true, awaiting_approval: false });
    } finally {
      offers.splice(offers.length - extra.length, extra.length);
      orders.splice(orders.length - 3, 3);
    }
  });
});

