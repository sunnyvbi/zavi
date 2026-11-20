
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeDb } from "./fake-supabase";

const m = vi.hoisted(() => ({ serviceClient: vi.fn() }));
vi.mock("@/services/supabase", () => ({ serviceClient: m.serviceClient }));

import { declineApprovedApplication, releaseApplicationAfterCancelledOrder } from "../briefs-db";
import { declineLateHire } from "../brief-applications";
import { findOrderByApplication, listOrdersByApplication } from "../booking-db";
import { loadCreatorJobReceipt } from "../receipt";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const APP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OLD = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NEW = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const BRIEF = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const MEMBER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const NOW = "2026-09-10T00:00:00.000Z";

function openBrief(over: Record<string, unknown> = {}) {
  return { id: BRIEF, tenant_id: TENANT_A, status: "sent", title: "3 ad videos", decline_note: null, closed_at: null, answer_by: "2026-09-16T00:00:00.000Z", ...over };
}

function approvedApp() {
  return { id: APP, tenant_id: TENANT_A, brief_id: BRIEF, human_member_id: MEMBER, status: "approved" };
}

function lateDecliner(sent: Array<{ to: string; event: string; scope: string | null }>) {
  return (a: { tenant_id: string; brief_id: string; application_id: string }) =>
    declineLateHire(a, {
      loadBrief: async () => null,
      decline: declineApprovedApplication,
      businessName: async () => "Northwind Coffee",
      notify: (async (n: { recipient: { human_member_id: string }; event: string; scope_id?: string | null }) => {
        sent.push({ to: n.recipient.human_member_id, event: n.event, scope: n.scope_id ?? null });
        return { written: true, emailed: true };
      }) as never,
    });
}

function order(id: string, status: string, created_at: string) {
  return {
    id,
    tenant_id: TENANT_A,
    application_id: APP,
    status,
    closed_reason: status === "cancelled" ? "payment_failed" : null,
    created_at,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("releaseApplicationAfterCancelledOrder", () => {
  it("puts the applicant back when their only order was cancelled", async () => {
    const db = makeFakeDb({
      creator_orders: [order(OLD, "cancelled", "2026-09-01T00:00:00Z")],
      brief_applications: [approvedApp()],
      creator_briefs: [openBrief()],
    });
    m.serviceClient.mockReturnValue(db.client);
    const sent: Array<{ to: string; event: string; scope: string | null }> = [];
    expect(
      await releaseApplicationAfterCancelledOrder(
        { tenant_id: TENANT_A, order_id: OLD },
        { declineLate: lateDecliner(sent), now: () => new Date(NOW) },
      ),
    ).toBe(true);
    expect(db.tables.brief_applications[0].status).toBe("applied");
    expect(sent).toEqual([]);
  });

  it("a hire that was PAID and then cancelled stays approved, never back to applied", async () => {
    for (const closed_reason of ["no_show", "cancel_agreed", "cancel_no_response", "mediation_refund"]) {
      const db = makeFakeDb({
        creator_orders: [{ ...order(OLD, "cancelled", "2026-09-01T00:00:00Z"), closed_reason }],
        brief_applications: [approvedApp()],
        creator_briefs: [openBrief()],
      });
      m.serviceClient.mockReturnValue(db.client);
      const sent: Array<{ to: string; event: string; scope: string | null }> = [];
      expect(
        await releaseApplicationAfterCancelledOrder(
          { tenant_id: TENANT_A, order_id: OLD },
          { declineLate: lateDecliner(sent), now: () => new Date(NOW) },
        ),
      ).toBe(false);
      expect(db.tables.brief_applications[0].status, closed_reason).toBe("approved");
      expect(sent, closed_reason).toEqual([]);
    }
  });

  it("an unpaid checkout that expires after the brief closed declines the applicant once, with the not-hired note", async () => {
    const db = makeFakeDb({
      creator_orders: [{ ...order(OLD, "cancelled", "2026-09-01T00:00:00Z"), closed_reason: "checkout_abandoned" }],
      brief_applications: [approvedApp()],
      creator_briefs: [openBrief({ closed_at: "2026-09-09T00:00:00.000Z" })],
    });
    m.serviceClient.mockReturnValue(db.client);
    const sent: Array<{ to: string; event: string; scope: string | null }> = [];
    const deps = { declineLate: lateDecliner(sent), now: () => new Date(NOW) };
    expect(await releaseApplicationAfterCancelledOrder({ tenant_id: TENANT_A, order_id: OLD }, deps)).toBe(false);
    expect(db.tables.brief_applications[0].status).toBe("rejected");
    expect(sent).toEqual([{ to: MEMBER, event: "not_hired", scope: APP }]);
    expect(await releaseApplicationAfterCancelledOrder({ tenant_id: TENANT_A, order_id: OLD }, deps)).toBe(false);
    expect(db.tables.brief_applications[0].status).toBe("rejected");
    expect(sent).toHaveLength(1);
  });

  it("an unpaid checkout that expires after the answer-by date declines even before the timer wrote closed_at", async () => {
    const db = makeFakeDb({
      creator_orders: [order(OLD, "cancelled", "2026-09-01T00:00:00Z")],
      brief_applications: [approvedApp()],
      creator_briefs: [openBrief({ answer_by: "2026-09-09T00:00:00.000Z" })],
    });
    m.serviceClient.mockReturnValue(db.client);
    const sent: Array<{ to: string; event: string; scope: string | null }> = [];
    expect(
      await releaseApplicationAfterCancelledOrder(
        { tenant_id: TENANT_A, order_id: OLD },
        { declineLate: lateDecliner(sent), now: () => new Date(NOW) },
      ),
    ).toBe(false);
    expect(db.tables.brief_applications[0].status).toBe("rejected");
    expect(sent).toEqual([{ to: MEMBER, event: "not_hired", scope: APP }]);
  });

  it("does NOT un-hire a second attempt that already has a live order", async () => {
    const db = makeFakeDb({
      creator_orders: [
        order(OLD, "cancelled", "2026-09-01T00:00:00Z"),
        order(NEW, "in_progress", "2026-09-02T00:00:00Z"),
      ],
      brief_applications: [{ id: APP, tenant_id: TENANT_A, status: "approved" }],
    });
    m.serviceClient.mockReturnValue(db.client);
    expect(await releaseApplicationAfterCancelledOrder({ tenant_id: TENANT_A, order_id: OLD })).toBe(false);
    expect(db.tables.brief_applications[0].status).toBe("approved");
  });

  it("ignores an order that is not cancelled", async () => {
    const db = makeFakeDb({
      creator_orders: [order(NEW, "in_progress", "2026-09-02T00:00:00Z")],
      brief_applications: [{ id: APP, tenant_id: TENANT_A, status: "approved" }],
    });
    m.serviceClient.mockReturnValue(db.client);
    expect(await releaseApplicationAfterCancelledOrder({ tenant_id: TENANT_A, order_id: NEW })).toBe(false);
    expect(db.tables.brief_applications[0].status).toBe("approved");
  });

  it("cannot reach another workspace's order", async () => {
    const db = makeFakeDb({
      creator_orders: [order(OLD, "cancelled", "2026-09-01T00:00:00Z")],
      brief_applications: [{ id: APP, tenant_id: TENANT_A, status: "approved" }],
    });
    m.serviceClient.mockReturnValue(db.client);
    expect(await releaseApplicationAfterCancelledOrder({ tenant_id: TENANT_B, order_id: OLD })).toBe(false);
    expect(db.tables.brief_applications[0].status).toBe("approved");
  });
});

describe("readers after a re-hire (two orders on one application)", () => {
  it("findOrderByApplication and listOrdersByApplication return the live hire", async () => {
    const db = makeFakeDb({
      creator_orders: [
        order(OLD, "cancelled", "2026-09-01T00:00:00Z"),
        order(NEW, "in_progress", "2026-09-02T00:00:00Z"),
      ],
    });
    m.serviceClient.mockReturnValue(db.client);
    expect((await findOrderByApplication(TENANT_A, APP))?.id).toBe(NEW);
    expect((await listOrdersByApplication(TENANT_A, [APP])).get(APP)?.status).toBe("in_progress");
  });

  it("a cancelled attempt AFTER a live one never hides it", async () => {
    const db = makeFakeDb({
      creator_orders: [
        order(NEW, "in_progress", "2026-09-01T00:00:00Z"),
        order(OLD, "cancelled", "2026-09-02T00:00:00Z"),
      ],
    });
    m.serviceClient.mockReturnValue(db.client);
    expect((await listOrdersByApplication(TENANT_A, [APP])).get(APP)?.status).toBe("in_progress");
    expect((await findOrderByApplication(TENANT_A, APP))?.id).toBe(NEW);
  });

  it("with only cancelled attempts, the latest one", async () => {
    const db = makeFakeDb({
      creator_orders: [
        order(OLD, "cancelled", "2026-09-01T00:00:00Z"),
        order(NEW, "cancelled", "2026-09-02T00:00:00Z"),
      ],
    });
    m.serviceClient.mockReturnValue(db.client);
    expect((await findOrderByApplication(TENANT_A, APP))?.id).toBe(NEW);
  });
});

describe("loadCreatorJobReceipt", () => {
  const paidOrder = {
    id: NEW,
    tenant_id: TENANT_A,
    currency: "usd",
    price_cents: 15_000,
    business_fee_cents: 1_500,
    business_total_cents: 16_500,
    livemode: false,
    stripe_payment_intent_id: "pi_1",
    chargeback_status: null,
  };
  const capture = { tenant_id: TENANT_A, order_id: NEW, kind: "capture", amount_cents: 16_500, created_at: "2026-09-02T00:00:00Z" };
  const receiptDeps = () => ({ receiptUrl: vi.fn(async () => "https://pay.stripe.com/receipts/r1") });

  it("reads the frozen amounts, the capture time and refunds from the ledger", async () => {
    const db = makeFakeDb({
      creator_orders: [paidOrder],
      creator_money_events: [
        { tenant_id: TENANT_A, order_id: NEW, kind: "hold", amount_cents: 16_500, created_at: "2026-09-01T00:00:00Z" },
        capture,
        { tenant_id: TENANT_A, order_id: NEW, kind: "refund", amount_cents: 5_000, created_at: "2026-09-05T00:00:00Z" },
      ],
    });
    m.serviceClient.mockReturnValue(db.client);
    expect(await loadCreatorJobReceipt(TENANT_A, NEW, receiptDeps())).toEqual({
      currency: "usd",
      price_cents: 15_000,
      business_fee_cents: 1_500,
      business_total_cents: 16_500,
      refunded_cents: 5_000,
      paid_at: "2026-09-02T00:00:00Z",
      receipt_url: "https://pay.stripe.com/receipts/r1",
      chargeback_status: null,
    });
  });

  it("is null before the card is charged (a hold is not a payment)", async () => {
    const db = makeFakeDb({
      creator_orders: [paidOrder],
      creator_money_events: [
        { tenant_id: TENANT_A, order_id: NEW, kind: "hold", amount_cents: 16_500, created_at: "2026-09-01T00:00:00Z" },
      ],
    });
    m.serviceClient.mockReturnValue(db.client);
    expect(await loadCreatorJobReceipt(TENANT_A, NEW, receiptDeps())).toBeNull();
  });

  it("another workspace reads no receipt at all, and Stripe is never asked", async () => {
    const db = makeFakeDb({ creator_orders: [paidOrder], creator_money_events: [capture] });
    m.serviceClient.mockReturnValue(db.client);
    const deps = receiptDeps();
    expect(await loadCreatorJobReceipt(TENANT_B, NEW, deps)).toBeNull();
    expect(deps.receiptUrl).not.toHaveBeenCalled();
  });

  it("still shows the receipt when Stripe cannot be read", async () => {
    const db = makeFakeDb({ creator_orders: [paidOrder], creator_money_events: [capture] });
    m.serviceClient.mockReturnValue(db.client);
    const r = await loadCreatorJobReceipt(TENANT_A, NEW, {
      receiptUrl: async () => {
        throw new Error("stripe down");
      },
    });
    expect(r?.receipt_url).toBeNull();
    expect(r?.business_total_cents).toBe(16_500);
  });
});
