
import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORDER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DISPUTE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CREATOR = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OTHER_TENANT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const H = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const state: { tables: Record<string, Row[]>; updates: Array<{ table: string; patch: Row }> } = {
    tables: {},
    updates: [],
  };

  function builder(table: string) {
    let rows: Row[] = [...(state.tables[table] ?? [])];
    let patch: Row | null = null;
    const b: Record<string, unknown> = {};
    const self = () => b as never;
    Object.assign(b, {
      select: () => self(),
      update: (p: Row) => {
        patch = p;
        return self();
      },
      eq: (col: string, val: unknown) => {
        rows = rows.filter((r) => r[col] === val);
        return self();
      },
      in: (col: string, vals: readonly unknown[]) => {
        rows = rows.filter((r) => (vals as unknown[]).includes(r[col]));
        return self();
      },
      not: (col: string, op: string, val: unknown) => {
        if (op === "in") {
          const set = String(val).replace(/^\(|\)$/g, "").split(",");
          rows = rows.filter((r) => !set.includes(String(r[col])));
        }
        return self();
      },
      order: () => self(),
      limit: (n: number) => {
        rows = rows.slice(0, n);
        return self();
      },
      maybeSingle: async () => {
        if (patch) for (const r of rows) Object.assign(r, patch);
        if (patch) state.updates.push({ table, patch });
        return { data: rows[0] ?? null, error: null };
      },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        if (patch) {
          for (const r of rows) Object.assign(r, patch);
          state.updates.push({ table, patch });
        }
        return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
      },
    });
    return b;
  }

  const client = {
    from: (t: string) => builder(t),
    storage: {
      from: () => ({
        createSignedUrl: async () => ({
          data: { signedUrl: "https://signed.test/deliverable" },
          error: null,
        }),
      }),
    },
  };

  return {
    state,
    client,
    apply: vi.fn(),
    audit: vi.fn(async (_row: Record<string, unknown>) => {}),
    library: vi.fn(async (_tid: string, _order: string) => ({ created: true, asset: { id: "asset-1" } })),
    log: vi.fn(async (_row: Record<string, unknown>) => {}),
  };
});

vi.mock("@/services/tenant-client", () => ({
  applySecretListEditRpc: async () => ({ data: null, error: null }),
  asTenantId: (t: string) => t,
  globalClient: () => H.client,
  staffCrossTenantClient: (reason: string) => {
    if (!reason || reason.trim().length < 8) throw new Error("reason required");
    return H.client;
  },
}));
vi.mock("@/services/creators/order-transitions", () => ({
  applyCreatorOrderTransition: H.apply,
}));
vi.mock("@/services/staff/audit", () => ({ writeStaffAudit: H.audit }));
vi.mock("@/services/creators/library", () => ({ createLibraryAssetOnApproval: H.library }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: H.log }));

import {
  staffCreatorDisputeQueue,
  staffCreatorDisputeDetail,
  staffCreatorDisputeResolve,
} from "../creator-network";
import {
  CREATOR_STAFF_PII_DENYLIST,
  MEDIATION_TRIGGER,
} from "@/services/creators/staff-console";

function mockRes() {
  const res = {
    statusCode: 200,
    payload: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.payload = body;
      return this;
    },
  };
  return res as any;
}

function staffReq(extra: Record<string, unknown> = {}) {
  return {
    staff: { user_id: "staff-1", email: "ops@zavi.test" },
    query: {},
    params: {},
    body: {},
    ...extra,
  } as any;
}

function orderRow(over: Record<string, unknown> = {}) {
  return {
    id: ORDER,
    tenant_id: TENANT,
    human_member_id: CREATOR,
    source: "booking",
    status: "in_dispute",
    closed_reason: null,
    currency: "usd",
    price_cents: 15000,
    business_fee_cents: 1500,
    creator_fee_cents: 2250,
    business_total_cents: 16500,
    creator_payout_cents: 12750,
    payout_amount_cents: null,
    payout_status: "not_due",
    payout_ready_at: null,
    due_at: "2026-09-20T00:00:00.000Z",
    accepted_at: "2026-09-12T00:00:00.000Z",
    closed_at: null,
    created_at: "2026-09-11T00:00:00.000Z",
    livemode: false,
    thread_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    package_snapshot: { title: "3 UGC videos", creator_country_code: "US" },
    brief_snapshot: { product: "Zavi" },
    stripe_payment_intent_id: "pi_LEAK",
    stripe_checkout_session_id: "cs_LEAK",
    stripe_transfer_id: "tr_LEAK",
    ...over,
  };
}

function seed(over: { disputeStatus?: string } = {}) {
  H.state.tables = {
    creator_disputes: [
      {
        id: DISPUTE,
        tenant_id: TENANT,
        order_id: ORDER,
        kind: "step_in",
        opened_by: "tenant",
        opened_by_user_id: "user-9",
        reason: "The videos do not match the brief.",
        status: over.disputeStatus ?? "open",
        outcome: over.disputeStatus === "resolved" ? "pay_full" : null,
        creator_amount_cents: null,
        refund_amount_cents: null,
        resolution_note: null,
        resolved_at: over.disputeStatus === "resolved" ? "2026-09-13T00:00:00.000Z" : null,
        created_at: "2026-09-12T10:00:00.000Z",
      },
    ],
    creator_orders: [orderRow()],
    creator_submissions: [
      {
        tenant_id: TENANT,
        order_id: ORDER,
        version: 1,
        position: 0,
        kind: "video",
        storage_path: `${TENANT}/${ORDER}/v1.mp4`,
        mime_type: "video/mp4",
        bytes: 1234,
        note: "first cut",
        created_at: "2026-09-12T08:00:00.000Z",
      },
      {
        tenant_id: TENANT,
        order_id: ORDER,
        version: 2,
        position: 0,
        kind: "video",
        storage_path: `${TENANT}/${ORDER}/v2.mp4`,
        mime_type: "video/mp4",
        bytes: 2345,
        note: "revised",
        created_at: "2026-09-12T09:00:00.000Z",
      },
    ],
    creator_thread_messages: [
      {
        tenant_id: TENANT,
        thread_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        sender_kind: "tenant",
        body: "Can you redo the hook?",
        created_at: "2026-09-12T08:30:00.000Z",
      },
      {
        tenant_id: TENANT,
        thread_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        sender_kind: "creator",
        body: "Done, see v2.",
        created_at: "2026-09-12T09:00:00.000Z",
      },
    ],
    creator_money_events: [
      {
        tenant_id: TENANT,
        order_id: ORDER,
        kind: "hold",
        cause: "booking",
        amount_cents: 16500,
        currency: "usd",
        actor_kind: "tenant",
        livemode: false,
        created_at: "2026-09-11T00:00:05.000Z",
        stripe_object_id: "pi_LEAK",
      },
      {
        tenant_id: TENANT,
        order_id: ORDER,
        kind: "capture",
        cause: "creator_accept",
        amount_cents: 16500,
        currency: "usd",
        actor_kind: "creator",
        livemode: false,
        created_at: "2026-09-12T00:00:00.000Z",
        stripe_object_id: "pi_LEAK",
      },
    ],
    human_members: [
      {
        id: CREATOR,
        display_name: "Ada Makes Ads",
        slug: "ada",
        vetting_state: "approved",
        city: "Austin",
        country_code: "US",
        missed_deadline_count: 1,
      },
    ],
    tenants: [{ id: TENANT, display_name: "Acme Coffee" }],
  };
  H.state.updates = [];
}

function okResult(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    order: {
      id: ORDER,
      status: "completed",
      closed_reason: "mediation_pay_full",
      payout_status: "ready",
      payout_amount_cents: null,
      ...((over.order as Record<string, unknown>) ?? {}),
    },
    trigger: "mediation_pay_full",
    from: "in_dispute",
    to: "completed",
    deadline: null,
    money: [],
    needs_staff_review: false,
    payout_waiting: false,
    ...over,
  };
}

function findDeniedKeys(body: unknown): string[] {
  const hits: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === "object") {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if ((CREATOR_STAFF_PII_DENYLIST as readonly string[]).includes(k)) hits.push(k);
        walk(val);
      }
    }
  };
  walk(body);
  return hits;
}

beforeEach(() => {
  seed();
  H.apply.mockReset();
  H.apply.mockImplementation(async () => {
    for (const d of H.state.tables.creator_disputes ?? []) d.status = "resolved";
    return okResult();
  });
  H.audit.mockClear();
  H.library.mockReset();
  H.library.mockResolvedValue({ created: true, asset: { id: "asset-1" } });
  H.log.mockClear();
});

describe("mediation outcomes each run exactly one S3 transition", () => {
  it("pay in full -> mediation_pay_full, once, with no amounts", async () => {
    const res = mockRes();
    await staffCreatorDisputeResolve(
      staffReq({ params: { id: DISPUTE }, body: { outcome: "pay_full" } }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(H.apply).toHaveBeenCalledTimes(1);
    const args = H.apply.mock.calls[0][0];
    expect(args.trigger).toBe("mediation_pay_full");
    expect(args.actor).toBe("staff");
    expect(args.actor_user_id).toBe("staff-1");
    expect(args.tenant_id).toBe(TENANT);
    expect(args.order_id).toBe(ORDER);
    expect(args.creator_amount_cents).toBeUndefined();
    expect(args.refund_amount_cents).toBeUndefined();
    expect(res.payload.money_frozen).toBe(false);
  });

  it("refund -> mediation_refund, once, with no amounts", async () => {
    H.apply.mockResolvedValue(
      okResult({
        trigger: "mediation_refund",
        order: { status: "cancelled", closed_reason: "mediation_refund", payout_status: "not_applicable" },
      }),
    );
    const res = mockRes();
    await staffCreatorDisputeResolve(
      staffReq({ params: { id: DISPUTE }, body: { outcome: "refund" } }),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(H.apply).toHaveBeenCalledTimes(1);
    expect(H.apply.mock.calls[0][0].trigger).toBe("mediation_refund");
    expect(H.apply.mock.calls[0][0].creator_amount_cents).toBeUndefined();
  });

  it("pay part -> mediation_pay_part, once, with BOTH amounts passed through untouched", async () => {
    H.apply.mockResolvedValue(
      okResult({
        trigger: "mediation_pay_part",
        order: {
          status: "completed",
          closed_reason: "mediation_pay_part",
          payout_status: "ready",
          payout_amount_cents: 6000,
        },
      }),
    );
    const res = mockRes();
    await staffCreatorDisputeResolve(
      staffReq({
        params: { id: DISPUTE },
        body: {
          outcome: "pay_part",
          creator_amount_cents: 6000,
          refund_amount_cents: 9000,
          note: "half the videos were usable",
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(H.apply).toHaveBeenCalledTimes(1);
    const args = H.apply.mock.calls[0][0];
    expect(args.trigger).toBe("mediation_pay_part");
    expect(args.creator_amount_cents).toBe(6000);
    expect(args.refund_amount_cents).toBe(9000);
    expect(args.note).toBe("half the videos were usable");
    expect(res.payload.payout_amount_cents).toBe(6000);
  });

  it("MEDIATION_TRIGGER maps each outcome to one distinct S3 trigger", () => {
    const triggers = Object.values(MEDIATION_TRIGGER);
    expect(triggers).toEqual(["mediation_pay_full", "mediation_pay_part", "mediation_refund"]);
    expect(new Set(triggers).size).toBe(3);
  });

  it("writes a staff audit row naming the outcome, the trigger and both amounts", async () => {
    await staffCreatorDisputeResolve(
      staffReq({
        params: { id: DISPUTE },
        body: { outcome: "pay_part", creator_amount_cents: 100, refund_amount_cents: 200 },
      }),
      mockRes(),
    );
    expect(H.audit).toHaveBeenCalledTimes(1);
    const row = H.audit.mock.calls[0][0] as any;
    expect(row.action).toBe("creator_dispute_resolved");
    expect(row.target_id).toBe(DISPUTE);
    expect(row.tenant_id).toBe(TENANT);
    expect(row.meta.outcome).toBe("pay_part");
    expect(row.meta.creator_amount_cents).toBe(100);
    expect(row.meta.refund_amount_cents).toBe(200);
  });
});

describe("money_frozen reflects whether the dispute actually closed", () => {
  it("answers money_frozen true when the transition left the dispute open", async () => {
    H.apply.mockResolvedValue(okResult({ needs_staff_review: true }));
    const res = mockRes();
    await staffCreatorDisputeResolve(staffReq({ params: { id: DISPUTE }, body: { outcome: "pay_full" } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.payload.money_frozen).toBe(true);
    expect(res.payload.needs_staff_review).toBe(true);
  });
});

describe("pay part needs BOTH amounts; Zavi never invents a split", () => {
  it.each([
    ["no amounts at all", {}],
    ["only the creator's share", { creator_amount_cents: 6000 }],
    ["only the refund", { refund_amount_cents: 9000 }],
  ])("refuses pay_part with %s and never touches the money", async (_label, amounts) => {
    const res = mockRes();
    await staffCreatorDisputeResolve(
      staffReq({ params: { id: DISPUTE }, body: { outcome: "pay_part", ...amounts } }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.payload.error.code).toBe("amounts_required");
    expect(H.apply).not.toHaveBeenCalled();
  });

  it.each(["pay_full", "refund"])(
    "refuses %s when amounts are sent, instead of ignoring them",
    async (outcome) => {
      const res = mockRes();
      await staffCreatorDisputeResolve(
        staffReq({ params: { id: DISPUTE }, body: { outcome, creator_amount_cents: 500 } }),
        res,
      );
      expect(res.statusCode).toBe(400);
      expect(res.payload.error.code).toBe("amounts_not_allowed");
      expect(H.apply).not.toHaveBeenCalled();
    },
  );

  it("refuses a zero or negative creator share before the executor is reached", async () => {
    for (const bad of [0, -1, 1.5]) {
      H.apply.mockClear();
      const res = mockRes();
      await staffCreatorDisputeResolve(
        staffReq({
          params: { id: DISPUTE },
          body: { outcome: "pay_part", creator_amount_cents: bad, refund_amount_cents: 100 },
        }),
        res,
      );
      expect(res.statusCode).toBe(400);
      expect(H.apply).not.toHaveBeenCalled();
    }
  });
});

describe("the request can never choose the tenant, the order or a mark", () => {
  it("refuses a body that tries to supply tenant_id or order_id", async () => {
    for (const extra of [{ tenant_id: OTHER_TENANT }, { order_id: ORDER }]) {
      H.apply.mockClear();
      const res = mockRes();
      await staffCreatorDisputeResolve(
        staffReq({ params: { id: DISPUTE }, body: { outcome: "pay_full", ...extra } }),
        res,
      );
      expect(res.statusCode).toBe(400);
      expect(res.payload.error.code).toBe("validation");
      expect(H.apply).not.toHaveBeenCalled();
    }
  });

  it("refuses a body that tries to hand-set a missed-deadline mark", async () => {
    const res = mockRes();
    await staffCreatorDisputeResolve(
      staffReq({
        params: { id: DISPUTE },
        body: { outcome: "pay_full", missed_deadline_count: 0 },
      }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(H.apply).not.toHaveBeenCalled();
  });

  it("rejects a non-UUID dispute id without reading anything", async () => {
    const res = mockRes();
    await staffCreatorDisputeResolve(
      staffReq({ params: { id: "not-a-uuid" }, body: { outcome: "pay_full" } }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.payload.error.code).toBe("invalid_id");
    expect(H.apply).not.toHaveBeenCalled();
  });
});

describe("a decided dispute cannot be decided twice", () => {
  it("answers dispute_not_open and moves no money", async () => {
    seed({ disputeStatus: "resolved" });
    const res = mockRes();
    await staffCreatorDisputeResolve(
      staffReq({ params: { id: DISPUTE }, body: { outcome: "refund" } }),
      res,
    );
    expect(res.statusCode).toBe(409);
    expect(res.payload.error.code).toBe("dispute_not_open");
    expect(H.apply).not.toHaveBeenCalled();
  });

  it("answers not_found for a dispute id that does not exist", async () => {
    H.state.tables.creator_disputes = [];
    const res = mockRes();
    await staffCreatorDisputeResolve(
      staffReq({ params: { id: DISPUTE }, body: { outcome: "pay_full" } }),
      res,
    );
    expect(res.statusCode).toBe(404);
    expect(H.apply).not.toHaveBeenCalled();
  });
});

describe("the mediation screen shows everything needed to judge", () => {
  it("queue lists the open dispute with money state, creator and marks", async () => {
    const res = mockRes();
    await staffCreatorDisputeQueue(staffReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.payload.order).toBe("oldest first");
    expect(res.payload.items).toHaveLength(1);
    const item = res.payload.items[0];
    expect(item.dispute_id).toBe(DISPUTE);
    expect(item.money_frozen).toBe(true);
    expect(item.tenant_name).toBe("Acme Coffee");
    expect(item.order.business_total_cents).toBe(16500);
    expect(item.order.creator_payout_cents).toBe(12750);
    expect(item.creator.display_name).toBe("Ada Makes Ads");
    expect(item.creator.missed_deadline_count).toBe(1);
    expect(item.creator.needs_staff_review).toBe(false);
    expect(item.creator.payout_country_supported).toBe(true);
  });

  it("a resolved dispute is not in the queue at all", async () => {
    seed({ disputeStatus: "resolved" });
    const res = mockRes();
    await staffCreatorDisputeQueue(staffReq(), res);
    expect(res.payload.items).toHaveLength(0);
  });

  it("detail carries the brief, every submission version, the whole thread, the money and the ledger", async () => {
    const res = mockRes();
    await staffCreatorDisputeDetail(staffReq({ params: { id: DISPUTE } }), res);
    expect(res.statusCode).toBe(200);
    const d = res.payload;

    expect(d.money_frozen).toBe(true);
    expect(d.brief.package_snapshot.title).toBe("3 UGC videos");
    expect(d.brief.brief_snapshot.product).toBe("Zavi");
    expect(d.submissions.map((s: any) => s.version)).toEqual([1, 2]);
    expect(d.submissions[0].signed_url).toBe("https://signed.test/deliverable");
    expect(d.thread.map((m: any) => m.sender_kind)).toEqual(["tenant", "creator"]);
    expect(d.ledger.map((l: any) => l.kind)).toEqual(["hold", "capture"]);
    expect(d.order.payout_status).toBe("not_due");
    expect(d.pay_part_limits).toEqual({
      max_creator_amount_cents: 12750,
      max_refund_amount_cents: 16500,
      max_total_cents: 16500,
    });
  });
});

describe("PII and Stripe ids never reach a staff response body", () => {
  it("the dispute queue body is clean", async () => {
    const res = mockRes();
    await staffCreatorDisputeQueue(staffReq(), res);
    const serialized = JSON.stringify(res.payload);
    expect(findDeniedKeys(JSON.parse(serialized))).toEqual([]);
    expect(serialized).not.toContain("pi_LEAK");
    expect(serialized).not.toContain("cs_LEAK");
    expect(serialized).not.toContain("tr_LEAK");
  });

  it("the dispute detail body is clean, ledger rows included", async () => {
    const res = mockRes();
    await staffCreatorDisputeDetail(staffReq({ params: { id: DISPUTE } }), res);
    const serialized = JSON.stringify(res.payload);
    expect(findDeniedKeys(JSON.parse(serialized))).toEqual([]);
    expect(serialized).not.toContain("pi_LEAK");
    expect(serialized).not.toContain("tr_LEAK");
  });

  it("the resolve body is clean", async () => {
    const res = mockRes();
    await staffCreatorDisputeResolve(
      staffReq({ params: { id: DISPUTE }, body: { outcome: "pay_full" } }),
      res,
    );
    expect(findDeniedKeys(JSON.parse(JSON.stringify(res.payload)))).toEqual([]);
  });
});

describe("a video paid through mediation lands in the Creators library", () => {
  it.each([
    ["pay_full", {}, okResult()],
    [
      "pay_part",
      { creator_amount_cents: 6000, refund_amount_cents: 9000 },
      okResult({
        trigger: "mediation_pay_part",
        order: { id: ORDER, status: "completed", closed_reason: "mediation_pay_part", payout_status: "ready", payout_amount_cents: 6000 },
      }),
    ],
  ])("%s writes the library asset once, for the dispute's own tenant and order", async (outcome, amounts, result) => {
    H.apply.mockResolvedValue(result);
    const res = mockRes();
    await staffCreatorDisputeResolve(
      staffReq({
        params: { id: DISPUTE },
        body: { outcome, ...amounts },
        tenant_id: OTHER_TENANT,
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(H.library).toHaveBeenCalledTimes(1);
    expect(H.library).toHaveBeenCalledWith(TENANT, ORDER);
    expect(H.apply.mock.invocationCallOrder[0]).toBeLessThan(H.library.mock.invocationCallOrder[0]);
  });

  it("a refund puts nothing in the library", async () => {
    H.apply.mockResolvedValue(
      okResult({ trigger: "mediation_refund", order: { status: "cancelled", closed_reason: "mediation_refund", payout_status: "not_applicable" } }),
    );
    const res = mockRes();
    await staffCreatorDisputeResolve(staffReq({ params: { id: DISPUTE }, body: { outcome: "refund" } }), res);
    expect(res.statusCode).toBe(200);
    expect(H.library).not.toHaveBeenCalled();
  });

  it("a refused transition puts nothing in the library", async () => {
    H.apply.mockResolvedValue({ ok: false, code: "illegal_transition", message: "no" });
    const res = mockRes();
    await staffCreatorDisputeResolve(staffReq({ params: { id: DISPUTE }, body: { outcome: "pay_full" } }), res);
    expect(res.statusCode).toBe(409);
    expect(H.library).not.toHaveBeenCalled();
  });

  it("a pay outcome that did not complete the order puts nothing in the library", async () => {
    H.apply.mockResolvedValue(okResult({ to: "in_dispute", order: { id: ORDER, status: "in_dispute", closed_reason: null, payout_status: "not_due", payout_amount_cents: null } }));
    const res = mockRes();
    await staffCreatorDisputeResolve(staffReq({ params: { id: DISPUTE }, body: { outcome: "pay_full" } }), res);
    expect(H.library).not.toHaveBeenCalled();
  });

  it("a library failure never fails the decision: the money answer still goes back, and it is logged", async () => {
    H.library.mockRejectedValue(new Error("storage down"));
    const res = mockRes();
    await staffCreatorDisputeResolve(staffReq({ params: { id: DISPUTE }, body: { outcome: "pay_full" } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({ dispute_id: DISPUTE, outcome: "pay_full", status: "completed", payout_status: "ready" });
    expect(H.audit).toHaveBeenCalledTimes(1);
    expect(H.log).toHaveBeenCalledWith(
      expect.objectContaining({ code: "mediation_library_failed", tenant_id: TENANT, meta: expect.objectContaining({ creator_order_id: ORDER }) }),
    );
  });
});
