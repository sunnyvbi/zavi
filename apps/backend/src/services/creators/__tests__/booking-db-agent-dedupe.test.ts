import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  ops: [] as Array<[string, string, unknown]>,
  inserted: [] as Array<Record<string, unknown>>,
  selects: [] as string[],
}));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (id: string) => id,
  tenantClient: () => {
    const filters: Array<(r: Record<string, unknown>) => boolean> = [];
    const q = {
      from: () => q,
      select: (cols?: string) => {
        if (typeof cols === "string") db.selects.push(cols);
        return q;
      },
      insert: (row: Record<string, unknown>) => {
        db.inserted.push(row);
        db.rows.push({ id: "new-order", ...row });
        filters.push((r) => r.id === "new-order");
        return q;
      },
      eq: (col: string, val: unknown) => {
        db.ops.push(["eq", col, val]);
        filters.push((r) => r[col] === val);
        return q;
      },
      is: (col: string, val: unknown) => {
        db.ops.push(["is", col, val]);
        filters.push((r) => r[col] === val);
        return q;
      },
      limit: () => q,
      maybeSingle: async () => ({ data: db.rows.find((r) => filters.every((f) => f(r))) ?? null, error: null }),
    };
    return q;
  },
}));

import { findPendingBooking, insertCreatorOrder, loadBookableOffer, loadOrderForCheckout } from "../booking-db";

const pending = (over: Record<string, unknown>) => ({
  id: "o1",
  source: "booking",
  status: "checkout_pending",
  human_member_id: "m1",
  package_id: "p1",
  booked_by_user_id: null,
  ...over,
});

beforeEach(() => {
  db.rows = [];
  db.ops = [];
  db.inserted = [];
  db.selects = [];
});

describe("a pending booking Zavi itself made (no founder user)", () => {
  it("is found again for the same creator and package, so a repeated agent booking reuses it", async () => {
    db.rows = [pending({ id: "agent-order" })];
    const found = await findPendingBooking({ tenant_id: "t1", human_member_id: "m1", package_id: "p1", booked_by_user_id: null });
    expect(found?.id).toBe("agent-order");
    expect(db.ops).toContainEqual(["is", "booked_by_user_id", null]);
  });

  it("never matches a founder's own pending booking for the same package", async () => {
    db.rows = [pending({ id: "founder-order", booked_by_user_id: "u1" })];
    expect(await findPendingBooking({ tenant_id: "t1", human_member_id: "m1", package_id: "p1", booked_by_user_id: null })).toBeNull();
  });

  it("a founder booking still matches only that founder's pending booking", async () => {
    db.rows = [pending({ id: "agent-order" }), pending({ id: "founder-order", booked_by_user_id: "u1" })];
    const found = await findPendingBooking({ tenant_id: "t1", human_member_id: "m1", package_id: "p1", booked_by_user_id: "u1" });
    expect(found?.id).toBe("founder-order");
  });
});

describe("the agent run stamp on the order (M2)", () => {
  const base = {
    tenant_id: "t1",
    human_member_id: "m1",
    source: "booking" as const,
    package_id: "p1",
    booked_by_user_id: null,
    package_snapshot: {},
    price_cents: 1000,
    business_fee_cents: 100,
    creator_fee_cents: 150,
    due_at: null,
    livemode: false,
  };

  it("writes agent_run_id onto the inserted order", async () => {
    await insertCreatorOrder({ ...base, agent_run_id: "run-1" });
    expect(db.inserted).toHaveLength(1);
    expect(db.inserted[0].agent_run_id).toBe("run-1");
  });

  it("a person's order is written with no agent run", async () => {
    await insertCreatorOrder({ ...base, booked_by_user_id: "u1" });
    expect(db.inserted[0]).toHaveProperty("agent_run_id", null);
  });

  it("the checkout read carries the stamp and the deadline, and the offer read carries the offer's run", async () => {
    db.rows = [{ id: "o1", agent_run_id: "run-1", next_deadline_at: "2026-10-23T00:00:00Z" }];
    await loadOrderForCheckout("t1", "o1");
    await loadBookableOffer("t1", "of1");
    const [checkoutCols, offerCols] = db.selects.map((c) => c.split(","));
    expect(checkoutCols).toEqual(expect.arrayContaining(["agent_run_id", "next_deadline_at"]));
    expect(offerCols).toContain("agent_run_id");
  });
});

