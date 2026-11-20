
import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  requests: 0,
  afterRequest: null as null | ((n: number) => void),
}));

vi.mock("@/services/tenant-client", () => {
  const MAX_ROWS = 1000;
  const build = () => {
    const filters: Array<(r: Record<string, unknown>) => boolean> = [];
    const orders: Array<{ col: string; asc: boolean }> = [];
    let lo = 0;
    let hi = Number.POSITIVE_INFINITY;
    const q: Record<string, unknown> = {};
    q.from = () => q;
    q.select = () => q;
    q.eq = (c: string, v: unknown) => (filters.push((r) => r[c] === v), q);
    q.neq = (c: string, v: unknown) => (filters.push((r) => r[c] !== v), q);
    q.in = (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), q);
    q.or = (expr: string) => {
      if (expr !== "closed_reason.is.null,closed_reason.neq.checkout_abandoned") throw new Error(`unexpected or ${expr}`);
      filters.push((r) => r.closed_reason == null || r.closed_reason !== "checkout_abandoned");
      return q;
    };
    q.order = (col: string, o?: { ascending?: boolean }) => (orders.push({ col, asc: o?.ascending !== false }), q);
    q.limit = (n: number) => ((hi = Math.min(hi, lo + n - 1)), q);
    q.range = (a: number, b: number) => ((lo = a), (hi = b), q);
    q.then = (resolve: (v: unknown) => unknown) => {
      db.requests += 1;
      const sorted = db.rows.filter((r) => filters.every((f) => f(r))).sort((x, y) => {
        for (const { col, asc } of orders) {
          const a = String(x[col]);
          const b = String(y[col]);
          if (a !== b) return (a < b ? -1 : 1) * (asc ? 1 : -1);
        }
        return 0;
      });
      const end = Math.min(hi, lo + MAX_ROWS - 1);
      const data = sorted.slice(lo, end + 1);
      db.afterRequest?.(db.requests);
      return resolve({ data, error: null });
    };
    return q;
  };
  return { creatorAreaClient: () => build(), globalClient: () => build() };
});

import { creatorEarnings, earningsBucket, listCreatorOrders, type CreatorAreaOrderRow } from "../creator-area";
import { computeCreatorFees } from "../order-fees";

function order(over: Partial<CreatorAreaOrderRow> = {}): CreatorAreaOrderRow {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    tenant_id: "22222222-2222-2222-2222-222222222222",
    human_member_id: "33333333-3333-3333-3333-333333333333",
    source: "booking",
    status: "in_progress",
    closed_reason: null,
    created_at: "2026-09-01T00:00:00.000Z",
    due_at: null,
    extension_requested_due_at: null,
    extension_state: null,
    next_deadline_at: null,
    next_deadline_kind: null,
    responded_at: null,
    accepted_at: null,
    cancel_requested_at: null,
    closed_at: null,
    payout_status: "not_due",
    payout_ready_at: null,
    payout_amount_cents: null,
    price_cents: 13_300,
    business_fee_cents: 1_330,
    creator_fee_cents: 1_995,
    business_total_cents: 14_630,
    creator_payout_cents: 11_305,
    package_snapshot: null,
    brief_snapshot: null,
    thread_id: null,
    livemode: false,
    currency: "usd",
    ...over,
  };
}

describe("nothing is called held before the card is captured", () => {
  it("drops the line at checkout_pending, when there is no PaymentIntent at all", () => {
    expect(earningsBucket(order({ status: "checkout_pending" }))).toBeNull();
  });

  it("drops the line at awaiting_acceptance, when the card is only authorised", () => {
    expect(earningsBucket(order({ status: "awaiting_acceptance" }))).toBeNull();
  });

  it("holds from in_progress onward, because capture happens on creator accept", () => {
    for (const status of ["in_progress", "submitted", "revision_requested"] as const) {
      expect(earningsBucket(order({ status }))).toBe("held");
    }
  });

  it("still holds while a cancellation or a dispute is open, the money is captured", () => {
    for (const status of ["cancel_requested", "in_dispute"] as const) {
      expect(earningsBucket(order({ status }))).toBe("held");
    }
  });

  it("drops a cancelled order, nothing was ever owed", () => {
    expect(earningsBucket(order({ status: "cancelled" }))).toBeNull();
  });
});

describe("dropping a line does not drop the fee-integrity check", () => {
  it("the two dropped statuses are the ones the isolation test covers", () => {
    const dropped = (["checkout_pending", "awaiting_acceptance", "in_progress", "submitted", "revision_requested", "cancel_requested", "in_dispute"] as const).filter(
      (status) => earningsBucket(order({ status })) === null,
    );
    expect(dropped).toEqual(["checkout_pending", "awaiting_acceptance"]);
  });
});

describe("the other payout states are unchanged", () => {
  it("awaiting_payout_account is held, and that is CORRECT", () => {
    expect(earningsBucket(order({ payout_status: "awaiting_payout_account" }))).toBe("held");
  });

  it("ready inside the 10 day buffer is held, and past it is on the way", () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const past = new Date(Date.now() - 86_400_000).toISOString();
    expect(earningsBucket(order({ payout_status: "ready", payout_ready_at: future }))).toBe("held");
    expect(earningsBucket(order({ payout_status: "ready", payout_ready_at: past }))).toBe(
      "on_the_way",
    );
  });

  it("transferring is on the way and transferred is paid", () => {
    expect(earningsBucket(order({ payout_status: "transferring" }))).toBe("on_the_way");
    expect(earningsBucket(order({ payout_status: "transferred" }))).toBe("paid");
  });

  it("not_applicable and reversed have no money line", () => {
    expect(earningsBucket(order({ payout_status: "not_applicable" }))).toBeNull();
    expect(earningsBucket(order({ payout_status: "reversed" }))).toBeNull();
  });
});

describe("a card dispute holds the payout", () => {
  it("reads held, not on the way, while the chargeback is open", () => {
    expect(
      earningsBucket(order({ status: "completed", payout_status: "ready", payout_ready_at: "2026-01-01T00:00:00Z", chargeback_status: "open" } as never)),
    ).toBe("held");
  });
  it("is on the way again once it is won", () => {
    expect(
      earningsBucket(order({ status: "completed", payout_status: "ready", payout_ready_at: "2026-01-01T00:00:00Z", chargeback_status: "won" } as never)),
    ).toBe("on_the_way");
  });
});

describe("a lost card dispute is not money on its way", () => {
  it("drops the line when the payout never left", () => {
    expect(earningsBucket(order({ status: "completed", payout_status: "ready", payout_ready_at: "2026-01-01T00:00:00Z", chargeback_status: "lost" } as never))).toBeNull();
  });
  it("keeps a payout that already went out as paid", () => {
    expect(earningsBucket(order({ status: "completed", payout_status: "transferred", chargeback_status: "lost" } as never))).toBe("paid");
  });
});

describe("earnings totals count every paid job, not the newest 100 orders", () => {
  const MEMBER = "33333333-3333-3333-3333-333333333333";
  const fees = computeCreatorFees(10_000);
  const money = {
    price_cents: 10_000,
    business_fee_cents: fees.business_fee_cents,
    creator_fee_cents: fees.creator_fee_cents,
    business_total_cents: fees.business_total_cents,
    creator_payout_cents: fees.creator_payout_cents,
  };
  const at = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();
  const id = (prefix: string, i: number) => `${prefix}-${String(i).padStart(6, "0")}`;
  const paidJob = (i: number) =>
    order({ ...money, id: id("paid", i), created_at: at(i), status: "completed", closed_reason: "approved", payout_status: "transferred" });
  const declined = (i: number) =>
    order({ ...money, id: id("declined", i), created_at: at(100_000 + i), status: "cancelled", closed_reason: "declined", payout_status: "not_applicable" });

  beforeEach(() => {
    db.rows = [];
    db.requests = 0;
    db.afterRequest = null;
  });

  it("sums 101 paid jobs even when 150 newer declined requests fill the first 100 rows", async () => {
    db.rows = [
      ...Array.from({ length: 101 }, (_, i) => paidJob(i)),
      ...Array.from({ length: 150 }, (_, i) => declined(i)),
      order({ ...money, id: "other-member", human_member_id: "44444444-4444-4444-4444-444444444444", payout_status: "transferred" }),
    ];
    expect(await listCreatorOrders(MEMBER)).toHaveLength(100);

    const e = await creatorEarnings(MEMBER);
    expect(e.paid_cents).toBe(101 * fees.creator_payout_cents);
    expect(e.lines).toHaveLength(100);
    expect(e.lines[0].order_id).toBe(id("paid", 100));
    expect(e.lines.every((l) => l.bucket === "paid")).toBe(true);
    expect(e.lines.some((l) => l.order_id === "other-member")).toBe(false);
  });

  it("pages past the 1000 row cap and keeps the newest 100 as lines", async () => {
    db.rows = [
      ...Array.from({ length: 2000 }, (_, i) => paidJob(i)),
      ...Array.from({ length: 300 }, (_, i) =>
        order({ ...money, id: id("held", i), created_at: at(50_000 + i), status: "in_progress", payout_status: "not_due" }),
      ),
    ];
    const e = await creatorEarnings(MEMBER);
    expect(e.paid_cents).toBe(2000 * fees.creator_payout_cents);
    expect(e.held_cents).toBe(300 * fees.creator_payout_cents);
    expect(e.lines).toHaveLength(100);
    expect(e.lines[0].order_id).toBe(id("held", 299));
    expect(e.lines[99].order_id).toBe(id("held", 200));
    expect(db.requests).toBe(3);
  });

  it("does not count a job twice when a new order lands between pages", async () => {
    db.rows = Array.from({ length: 1500 }, (_, i) => paidJob(i));
    db.afterRequest = (n) => {
      if (n === 1) db.rows.push(paidJob(9_999));
    };
    const e = await creatorEarnings(MEMBER);
    expect(e.paid_cents).toBe(1500 * fees.creator_payout_cents);
  });

  it("still refuses a drifted fee row beyond the first 100", async () => {
    db.rows = [
      ...Array.from({ length: 120 }, (_, i) => paidJob(1_000 + i)),
      { ...paidJob(0), creator_payout_cents: fees.creator_payout_cents + 1 },
    ];
    await expect(creatorEarnings(MEMBER)).rejects.toMatchObject({ code: "order_fees_inconsistent" });
  });
});
