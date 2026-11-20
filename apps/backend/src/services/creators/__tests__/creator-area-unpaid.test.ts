
import { describe, expect, it, vi } from "vitest";

const calls: Array<[string, unknown[]]> = [];

vi.mock("@/services/tenant-client", () => {
  const q: Record<string, unknown> = {};
  for (const m of ["from", "select", "eq", "neq", "or", "in", "order", "limit"]) {
    q[m] = (...args: unknown[]) => {
      calls.push([m, args]);
      return q;
    };
  }
  q.maybeSingle = async () => ({ data: null, error: null });
  q.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null });
  return { creatorAreaClient: () => q, globalClient: () => q };
});

import { listCreatorOrders, loadCreatorOrder } from "../creator-area";
import { isNeverPaidOrder, PAID_ORDER_FILTER } from "../order-state";

const MEMBER = "33333333-3333-3333-3333-333333333333";

describe("creator order reads never include checkout_pending", () => {
  it("every list (Jobs, Inbox, Earnings) filters it out", async () => {
    calls.length = 0;
    await listCreatorOrders(MEMBER);
    expect(calls).toContainEqual(["neq", ["status", "checkout_pending"]]);
    expect(calls).toContainEqual(["or", [PAID_ORDER_FILTER]]);
    expect(calls).toContainEqual(["eq", ["human_member_id", MEMBER]]);
  });

  it("a single job read does too, so an unpaid order is a 404 for the creator", async () => {
    calls.length = 0;
    await loadCreatorOrder(MEMBER, "22222222-2222-2222-2222-222222222222");
    expect(calls).toContainEqual(["neq", ["status", "checkout_pending"]]);
    expect(calls).toContainEqual(["or", [PAID_ORDER_FILTER]]);
  });
});

describe("isNeverPaidOrder", () => {
  it("is an order in checkout, or one closed because nobody paid", () => {
    expect(isNeverPaidOrder({ status: "checkout_pending", closed_reason: null })).toBe(true);
    expect(isNeverPaidOrder({ status: "cancelled", closed_reason: "checkout_abandoned" })).toBe(true);
  });

  it("is not a paid job, open or closed", () => {
    expect(isNeverPaidOrder({ status: "awaiting_acceptance", closed_reason: null })).toBe(false);
    expect(isNeverPaidOrder({ status: "cancelled", closed_reason: "declined" })).toBe(false);
    expect(isNeverPaidOrder({ status: "cancelled", closed_reason: "mediation_refund" })).toBe(false);
    expect(isNeverPaidOrder({ status: "completed", closed_reason: "approved" })).toBe(false);
  });
});
