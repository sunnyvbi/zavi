import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const { db } = vi.hoisted(() => {
  const tables: Record<string, Row[]> = {};

  function orFilter(expr: string): (r: Row) => boolean {
    const parts = expr.split(",").map((p) => {
      const [col, op, ...rest] = p.split(".");
      const val = rest.join(".");
      if (op === "is" && val === "null") return (r: Row) => r[col] == null;
      if (op === "eq") return (r: Row) => String(r[col]) === val;
      throw new Error(`fake: unsupported or() part ${p}`);
    });
    return (r) => parts.some((f) => f(r));
  }

  function builder(table: string, mode: "select" | "update", values?: Row) {
    const filters: ((r: Row) => boolean)[] = [];
    let orderCol: string | null = null;
    let limitN: number | null = null;
    const rows = () => {
      let out = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (orderCol) {
        const c = orderCol;
        out = [...out].sort((a, b) => String(a[c]).localeCompare(String(b[c])));
      }
      if (limitN != null) out = out.slice(0, limitN);
      return out;
    };
    const settle = () => {
      const hit = rows();
      if (mode === "update") for (const r of hit) Object.assign(r, values);
      return { data: hit.map((r) => ({ ...r })), error: null };
    };
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (c: string, v: unknown) => {
        filters.push((r) => r[c] === v);
        return b;
      },
      lte: (c: string, v: string) => {
        filters.push((r) => String(r[c]) <= v);
        return b;
      },
      or: (expr: string) => {
        filters.push(orFilter(expr));
        return b;
      },
      order: (c: string) => {
        orderCol = c;
        return b;
      },
      limit: (n: number) => {
        limitN = n;
        return b;
      },
      maybeSingle: async () => {
        const r = settle();
        return { data: r.data[0] ?? null, error: null };
      },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(settle()).then(res, rej),
    };
    return b;
  }

  const client = {
    from: (table: string) => ({
      select: () => builder(table, "select"),
      update: (values: Row) => builder(table, "update", values),
    }),
  };
  return { db: { tables, client } };
});

vi.mock("@/services/tenant-client", () => ({
  tenantClient: () => db.client,
  creatorTimerClient: () => db.client,
  globalClient: () => db.client,
  creatorOrderRpc: () => {
    throw new Error("not used");
  },
  asTenantId: (t: string) => t,
}));

import { listDuePayoutOrders, writeOrderState } from "../orders-db";

const TENANT = "t-1";
const PAST = "2026-01-01T00:00:00.000Z";

function order(id: string, over: Row = {}): Row {
  return {
    id,
    tenant_id: TENANT,
    human_member_id: `hm-${id}`,
    status: "completed",
    payout_status: "ready",
    payout_ready_at: PAST,
    chargeback_status: null,
    ...over,
  };
}

beforeEach(() => {
  for (const k of Object.keys(db.tables)) delete db.tables[k];
});

describe("listDuePayoutOrders", () => {
  it("never lists an order whose step-in dispute is still open", async () => {
    db.tables.creator_orders = [
      order("a-disputed", { payout_ready_at: "2026-01-01T00:00:00.000Z" }),
      order("b-resolved", { payout_ready_at: "2026-01-02T00:00:00.000Z" }),
      order("c-clean", { payout_ready_at: "2026-01-03T00:00:00.000Z" }),
    ];
    db.tables.creator_disputes = [
      { order_id: "a-disputed", status: "open" },
      { order_id: "b-resolved", status: "resolved" },
    ];

    const due = await listDuePayoutOrders(100);

    expect(due.map((d) => d.id)).toEqual(["b-resolved", "c-clean"]);
  });

  it("a disputed order does not use up the sweep's slots", async () => {
    db.tables.creator_orders = [
      order("a-disputed", { payout_ready_at: "2026-01-01T00:00:00.000Z" }),
      order("b-disputed", { payout_ready_at: "2026-01-02T00:00:00.000Z" }),
      order("c-clean", { payout_ready_at: "2026-01-03T00:00:00.000Z" }),
      order("d-clean", { payout_ready_at: "2026-01-04T00:00:00.000Z" }),
      order("e-clean", { payout_ready_at: "2026-01-05T00:00:00.000Z" }),
    ];
    db.tables.creator_disputes = [
      { order_id: "a-disputed", status: "open" },
      { order_id: "b-disputed", status: "open" },
    ];

    const due = await listDuePayoutOrders(2);

    expect(due.map((d) => d.id)).toEqual(["c-clean", "d-clean"]);
  });

  it("still drops open or lost chargebacks and orders not yet due", async () => {
    db.tables.creator_orders = [
      order("cb-open", { chargeback_status: "open" }),
      order("cb-lost", { chargeback_status: "lost" }),
      order("cb-won", { chargeback_status: "won" }),
      order("future", { payout_ready_at: "2999-01-01T00:00:00.000Z" }),
      order("parked", { payout_status: "awaiting_payout_account" }),
    ];
    db.tables.creator_disputes = [];

    const due = await listDuePayoutOrders(100);

    expect(due.map((d) => d.id)).toEqual(["cb-won"]);
  });
});

describe("writeOrderState with expected_payout_status", () => {
  it("does not overwrite a payout that already transferred", async () => {
    db.tables.creator_orders = [order("o-1", { payout_status: "transferred" })];

    const res = await writeOrderState({
      tenant_id: TENANT,
      order_id: "o-1",
      expected_status: "completed",
      expected_payout_status: "ready",
      patch: { payout_status: "awaiting_payout_account" },
    });

    expect(res).toBeNull();
    expect(db.tables.creator_orders[0].payout_status).toBe("transferred");
  });

  it("parks a payout that is still ready", async () => {
    db.tables.creator_orders = [order("o-1")];

    const res = await writeOrderState({
      tenant_id: TENANT,
      order_id: "o-1",
      expected_status: "completed",
      expected_payout_status: "ready",
      patch: { payout_status: "awaiting_payout_account" },
    });

    expect(res).not.toBeNull();
    expect(db.tables.creator_orders[0].payout_status).toBe("awaiting_payout_account");
  });

  it("without the extra guard it still writes on status alone", async () => {
    db.tables.creator_orders = [order("o-1", { payout_status: "transferred" })];

    const res = await writeOrderState({
      tenant_id: TENANT,
      order_id: "o-1",
      expected_status: "completed",
      patch: { next_deadline_at: null },
    });

    expect(res).not.toBeNull();
  });
});
