
import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORDER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DISPUTE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CREATOR = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const H = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const state = {
    order: {} as Row,
    ledger: [] as Array<{ kind: string; cause: string; amount_cents: number; actor_kind: string }>,
    resolved: [] as Row[],
    disputeRow: {} as Row,
    hasOpenDispute: false,
    resolveFails: false,
    writes: 0,
  };

  function builder(table: string) {
    let rows: Row[] =
      table === "creator_disputes"
        ? [state.disputeRow]
        : table === "creator_orders"
          ? [{ id: ORDER, tenant_id: TENANT, human_member_id: CREATOR }]
          : [];
    const b: Record<string, unknown> = {};
    const self = () => b as never;
    Object.assign(b, {
      select: () => self(),
      eq: (col: string, val: unknown) => {
        rows = rows.filter((r) => r[col] === val);
        return self();
      },
      in: () => self(),
      order: () => self(),
      limit: () => self(),
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve({ data: rows, error: null }).then(res, rej),
    });
    return b;
  }
  const client = { from: (t: string) => builder(t), storage: { from: () => ({}) } };

  const moneyCalls: string[] = [];
  const money = {
    capture: async (args: { cause: string }) => {
      moneyCalls.push(`capture:${args.cause}`);
      state.ledger.push({
        kind: "capture",
        cause: args.cause,
        amount_cents: Number(state.order.business_total_cents),
        actor_kind: "system",
      });
      return { ok: true, payment_intent_id: "pi_1", charge_id: "ch_1", amount_cents: 16_500, already_captured: false };
    },
    cancelHold: async (args: { cause: string }) => {
      moneyCalls.push(`cancel_hold:${args.cause}`);
      state.ledger.push({
        kind: "cancel",
        cause: args.cause,
        amount_cents: Number(state.order.business_total_cents),
        actor_kind: "system",
      });
      return { ok: true, payment_intent_id: "pi_1", already_released: false };
    },
    transfer: async (args: { cause: string }) => {
      moneyCalls.push(`transfer:${args.cause}`);
      const amount = Number(state.order.payout_amount_cents ?? state.order.creator_payout_cents);
      state.ledger.push({ kind: "transfer", cause: args.cause, amount_cents: amount, actor_kind: "system" });
      return { ok: true, transfer_id: "tr_1", amount_cents: amount, already_transferred: false, recorded: true };
    },
    refund: async (args: { cause: string; amount_cents?: number; actor_kind?: string }) => {
      moneyCalls.push(`refund:${args.cause}`);
      const amount = args.amount_cents ?? Number(state.order.business_total_cents);
      state.ledger.push({
        kind: "refund",
        cause: args.cause,
        amount_cents: amount,
        actor_kind: args.actor_kind ?? "system",
      });
      return {
        refund_id: "re_1",
        refunded_cents: amount,
        already_refunded: false,
        reversed_cents: 0,
        reversal_shortfall_cents: 0,
        needs_staff_review: false,
      };
    },
  };

  return { state, client, money, moneyCalls, audit: vi.fn(async (_row: Record<string, unknown>) => {}) };
});

vi.mock("@/services/tenant-client", () => ({
  applySecretListEditRpc: async () => ({ data: null, error: null }),
  globalClient: () => H.client,
  staffCrossTenantClient: () => H.client,
}));
vi.mock("@/services/staff/audit", () => ({ writeStaffAudit: H.audit }));

vi.mock("@/services/creators/orders-db", async () => ({
  ORDER_STATE_COLUMNS: (
    await vi.importActual<typeof import("@/services/creators/orders-db")>(
      "@/services/creators/orders-db",
    )
  ).ORDER_STATE_COLUMNS,
  discardOpenCreatorDispute: async () => 0,
  loadOrderForState: async (tid: string, oid: string) =>
    tid === TENANT && oid === ORDER ? { ...H.state.order } : null,
  writeOrderState: async ({ expected_status, patch }: { expected_status: string; patch: Record<string, unknown> }) => {
    if (H.state.order.status !== expected_status) return null;
    H.state.writes += 1;
    H.state.order = { ...H.state.order, ...patch };
    return { ...H.state.order };
  },
  latestSubmissionAt: async () => null,
  submissionRounds: async () => 0,
  openCreatorDispute: async () => "opened",
  resolveCreatorDispute: async (args: Record<string, unknown>) => {
    if (H.state.resolveFails) throw new Error("creator_disputes update timed out");
    H.state.resolved.push(args);
    H.state.disputeRow = { ...H.state.disputeRow, status: "resolved" };
    return 1;
  },
  hasOpenCreatorDispute: async () => H.state.hasOpenDispute,
  markMissedDeadline: async () => 1,
  claimOrderDeadline: async () => null,
  releaseOrderDeadlineLease: async () => 0,
}));
vi.mock("@/services/creators/ports", () => ({
  realCreatorMoneyPort: H.money,
  realCreatorNotifyPort: {
    notify: async () => ({ written: true, emailed: true }),
    notifyBothSides: async () => ({
      creator: { written: true, emailed: true },
      tenant: { written: true, emailed: true },
    }),
    sendWindowReminder: async () => ({ written: true, emailed: true }),
  },
}));

import { staffCreatorDisputeResolve } from "../creator-network";

function mockRes() {
  const res = {
    statusCode: 200,
    payload: undefined as any,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.payload = b;
      return this;
    },
  };
  return res as any;
}

const staffReq = (body: Record<string, unknown>) =>
  ({
    staff: { user_id: "staff-1", email: "ops@zavi.test" },
    params: { id: DISPUTE },
    query: {},
    body,
  }) as any;

beforeEach(() => {
  H.state.order = {
    id: ORDER,
    tenant_id: TENANT,
    human_member_id: CREATOR,
    source: "booking",
    status: "in_dispute",
    closed_reason: null,
    created_at: "2026-09-11T00:00:00.000Z",
    due_at: null,
    extension_requested_due_at: null,
    extension_state: null,
    next_deadline_at: null,
    next_deadline_kind: null,
    responded_at: "2026-09-11T01:00:00.000Z",
    accepted_at: "2026-09-11T01:00:00.000Z",
    cancel_requested_at: null,
    closed_at: null,
    payout_status: "not_due",
    payout_ready_at: null,
    payout_amount_cents: null,
    price_cents: 15_000,
    business_fee_cents: 1_500,
    creator_fee_cents: 2_250,
    business_total_cents: 16_500,
    creator_payout_cents: 12_750,
    package_snapshot: { title: "3 ad videos", creator_country_code: "US" },
    livemode: false,
  };
  H.state.disputeRow = {
    id: DISPUTE,
    tenant_id: TENANT,
    order_id: ORDER,
    status: "open",
  };
  H.state.hasOpenDispute = false;
  H.state.resolveFails = false;
  H.state.ledger = [];
  H.state.resolved = [];
  H.state.writes = 0;
  H.moneyCalls.length = 0;
  H.audit.mockClear();
});

describe("pay in full", () => {
  it("transfers the creator's whole payout, once, and lands one ledger row", async () => {
    const res = mockRes();
    await staffCreatorDisputeResolve(staffReq({ outcome: "pay_full" }), res);

    expect(res.statusCode).toBe(200);
    expect(H.moneyCalls).toEqual(["transfer:mediation"]);
    expect(H.state.ledger).toEqual([
      { kind: "transfer", cause: "mediation", amount_cents: 12_750, actor_kind: "system" },
    ]);
    expect(H.state.order.status).toBe("completed");
    expect(H.state.order.closed_reason).toBe("mediation_pay_full");
    expect(H.state.order.payout_status).toBe("ready");
    expect(H.state.writes).toBe(1);
    expect(res.payload.money_frozen).toBe(false);
  });

  it("closes the dispute with the outcome, which is what lifts the freeze", async () => {
    await staffCreatorDisputeResolve(staffReq({ outcome: "pay_full" }), mockRes());
    expect(H.state.resolved).toHaveLength(1);
    expect(H.state.resolved[0]).toMatchObject({
      order_id: ORDER,
      outcome: "pay_full",
      resolved_by_staff_id: "staff-1",
    });
  });
});

describe("pay in full when closing the dispute fails", () => {
  it("still pays the creator but tells staff the money is frozen, because the dispute is still open", async () => {
    H.state.resolveFails = true;
    const res = mockRes();
    await staffCreatorDisputeResolve(staffReq({ outcome: "pay_full" }), res);

    expect(res.statusCode).toBe(200);
    expect(H.state.resolved).toHaveLength(0);
    expect(H.state.disputeRow.status).toBe("open");
    expect(H.moneyCalls).toEqual(["transfer:mediation"]);
    expect(res.payload.needs_staff_review).toBe(true);
    expect(res.payload.money_frozen).toBe(true);
  });

  it("a later retry is not refused as already decided, since the dispute never closed", async () => {
    H.state.resolveFails = true;
    await staffCreatorDisputeResolve(staffReq({ outcome: "pay_full" }), mockRes());
    H.state.resolveFails = false;
    H.state.order = { ...H.state.order, status: "in_dispute" };
    const res = mockRes();
    await staffCreatorDisputeResolve(staffReq({ outcome: "pay_full" }), res);
    expect(res.statusCode).toBe(200);
    expect(res.payload.money_frozen).toBe(false);
  });
});

describe("pay part", () => {
  it("refunds the business FIRST, then pays the creator, with exactly the typed amounts", async () => {
    const res = mockRes();
    await staffCreatorDisputeResolve(
      staffReq({ outcome: "pay_part", creator_amount_cents: 6_000, refund_amount_cents: 9_000 }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(H.moneyCalls).toEqual(["refund:mediation", "transfer:mediation"]);
    expect(H.state.ledger).toEqual([
      { kind: "refund", cause: "mediation", amount_cents: 9_000, actor_kind: "staff" },
      { kind: "transfer", cause: "mediation", amount_cents: 6_000, actor_kind: "system" },
    ]);
    expect(H.state.order.payout_amount_cents).toBe(6_000);
    expect(H.state.order.closed_reason).toBe("mediation_pay_part");
    expect(H.state.writes).toBe(1);
  });

  it("records both amounts on the dispute, so the decision is auditable", async () => {
    await staffCreatorDisputeResolve(
      staffReq({ outcome: "pay_part", creator_amount_cents: 6_000, refund_amount_cents: 9_000 }),
      mockRes(),
    );
    expect(H.state.resolved[0]).toMatchObject({
      outcome: "pay_part",
      creator_amount_cents: 6_000,
      refund_amount_cents: 9_000,
    });
  });

  it("refuses a creator share above the creator's payout, and moves nothing", async () => {
    const res = mockRes();
    await staffCreatorDisputeResolve(
      staffReq({ outcome: "pay_part", creator_amount_cents: 12_751, refund_amount_cents: 100 }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.payload.error.code).toBe("invalid_amount");
    expect(H.moneyCalls).toEqual([]);
    expect(H.state.ledger).toEqual([]);
    expect(H.state.writes).toBe(0);
  });

  it("refuses a refund above the business total, and moves nothing", async () => {
    const res = mockRes();
    await staffCreatorDisputeResolve(
      staffReq({ outcome: "pay_part", creator_amount_cents: 100, refund_amount_cents: 16_501 }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.payload.error.code).toBe("invalid_amount");
    expect(H.moneyCalls).toEqual([]);
    expect(H.state.writes).toBe(0);
  });
});

describe("refund", () => {
  it("refunds the business total including the 10% Zavi fee, once", async () => {
    const res = mockRes();
    await staffCreatorDisputeResolve(staffReq({ outcome: "refund" }), res);

    expect(res.statusCode).toBe(200);
    expect(H.moneyCalls).toEqual(["refund:mediation"]);
    expect(H.state.ledger).toEqual([
      { kind: "refund", cause: "mediation", amount_cents: 16_500, actor_kind: "staff" },
    ]);
    expect(H.state.order.status).toBe("cancelled");
    expect(H.state.order.closed_reason).toBe("mediation_refund");
    expect(H.state.order.payout_status).toBe("not_applicable");
    expect(H.state.writes).toBe(1);
  });
});

describe("an order that is not in dispute cannot be mediated", () => {
  it("a completed order with no open dispute answers illegal_transition and moves no money", async () => {
    H.state.order.status = "completed";
    H.state.order.closed_reason = "approved";
    H.state.hasOpenDispute = false;
    const res = mockRes();
    await staffCreatorDisputeResolve(staffReq({ outcome: "pay_full" }), res);
    expect(res.statusCode).toBe(409);
    expect(res.payload.error.code).toBe("illegal_transition");
    expect(H.moneyCalls).toEqual([]);
    expect(H.state.writes).toBe(0);
  });
});

describe("mediation resolves a dispute opened during the payout buffer", () => {
  function inBuffer() {
    H.state.order.status = "completed";
    H.state.order.closed_reason = "auto_accepted";
    H.state.order.closed_at = "2026-09-20T00:00:00.000Z";
    H.state.order.payout_status = "ready";
    H.state.order.payout_ready_at = "2026-09-30T00:00:00.000Z";
    H.state.hasOpenDispute = true;
  }

  const cases = [
    {
      outcome: "pay_full",
      body: {} as Record<string, unknown>,
      money: ["transfer:mediation"],
      ledger: [{ kind: "transfer", cause: "mediation", amount_cents: 12_750, actor_kind: "system" }],
      status: "completed",
    },
    {
      outcome: "pay_part",
      body: { creator_amount_cents: 6_000, refund_amount_cents: 9_000 },
      money: ["refund:mediation", "transfer:mediation"],
      ledger: [
        { kind: "refund", cause: "mediation", amount_cents: 9_000, actor_kind: "staff" },
        { kind: "transfer", cause: "mediation", amount_cents: 6_000, actor_kind: "system" },
      ],
      status: "completed",
    },
    {
      outcome: "refund",
      body: {} as Record<string, unknown>,
      money: ["refund:mediation"],
      ledger: [{ kind: "refund", cause: "mediation", amount_cents: 16_500, actor_kind: "staff" }],
      status: "cancelled",
    },
  ] as const;

  for (const c of cases) {
    it(`${c.outcome} moves money exactly once and closes the dispute`, async () => {
      inBuffer();
      const res = mockRes();
      await staffCreatorDisputeResolve(staffReq({ outcome: c.outcome, ...c.body }), res);

      expect(res.statusCode).toBe(200);
      expect(H.moneyCalls).toEqual(c.money);
      expect(H.state.ledger).toEqual(c.ledger);
      expect(H.state.order.status).toBe(c.status);
      expect(H.state.writes).toBe(1);
      expect(H.state.resolved).toHaveLength(1);
      expect(H.state.resolved[0]).toMatchObject({ order_id: ORDER, outcome: c.outcome });
    });
  }

  it("keeps the auto-accept history when the order stays completed", async () => {
    inBuffer();
    await staffCreatorDisputeResolve(staffReq({ outcome: "pay_full" }), mockRes());
    expect(H.state.order.closed_reason).toBe("auto_accepted");
    expect(H.state.order.closed_at).toBe("2026-09-20T00:00:00.000Z");
  });

  it("a refund outcome closes the order as cancelled, with the mediation reason", async () => {
    inBuffer();
    await staffCreatorDisputeResolve(staffReq({ outcome: "refund" }), mockRes());
    expect(H.state.order.status).toBe("cancelled");
    expect(H.state.order.closed_reason).toBe("mediation_refund");
    expect(H.state.order.payout_status).toBe("not_applicable");
  });
});
