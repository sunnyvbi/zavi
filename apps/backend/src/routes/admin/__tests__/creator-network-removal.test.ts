
import { describe, it, expect, vi, beforeEach } from "vitest";

const CREATOR = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const T1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const T2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";

const O_CHECKOUT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const O_AWAITING = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const O_IN_PROGRESS = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3";
const O_SUBMITTED = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4";
const O_COMPLETED = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5";

const H = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const state: {
    tables: Record<string, Row[]>;
    updates: Array<{ table: string; patch: Row; ids: string[] }>;
  } = { tables: {}, updates: [] };

  function builder(table: string) {
    let rows: Row[] = [...(state.tables[table] ?? [])];
    let patch: Row | null = null;
    const b: Record<string, unknown> = {};
    const self = () => b as never;
    const flush = () => {
      if (!patch) return;
      state.updates.push({
        table,
        patch,
        ids: rows.map((r) => String(r.id)),
      });
      for (const r of rows) Object.assign(r, patch);
      patch = null;
    };
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
        flush();
        return { data: rows[0] ?? null, error: null };
      },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
        flush();
        return Promise.resolve({ data: rows, error: null }).then(res, rej);
      },
    });
    return b;
  }

  const client = {
    from: (t: string) => builder(t),
    storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: { message: "x" } }) }) },
  };

  return {
    state,
    client,
    apply: vi.fn(),
    audit: vi.fn(async (_row: Record<string, unknown>) => {}),
    setVettingState: vi.fn(),
    getMemberDetail: vi.fn(),
  };
});

vi.mock("@/services/tenant-client", () => ({
  applySecretListEditRpc: async () => ({ data: null, error: null }),
  globalClient: () => H.client,
  staffCrossTenantClient: () => H.client,
}));
vi.mock("@/services/creators/order-transitions", () => ({
  applyCreatorOrderTransition: H.apply,
}));
vi.mock("@/services/staff/audit", () => ({ writeStaffAudit: H.audit }));
vi.mock("@/services/humans/store", () => ({
  setVettingState: H.setVettingState,
  getMemberDetail: H.getMemberDetail,
}));

import { staffCreatorDetail, staffCreatorRemove } from "../creator-network";
import {
  MISSED_DEADLINE_REVIEW_THRESHOLD,
  REMOVAL_CANCELS_ORDER_STATUSES,
  CREATOR_STAFF_PII_DENYLIST,
} from "@/services/creators/staff-console";
import { TRANSITIONS } from "@/services/creators/order-state";

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

const staffReq = (over: Record<string, unknown> = {}) =>
  ({
    staff: { user_id: "staff-1", email: "ops@zavi.test" },
    params: { id: CREATOR },
    query: {},
    body: {},
    ...over,
  }) as any;

function seed(over: { marks?: number } = {}) {
  H.state.tables = {
    creator_orders: [
      { id: O_CHECKOUT, tenant_id: T1, human_member_id: CREATOR, status: "checkout_pending", created_at: "1" },
      { id: O_AWAITING, tenant_id: T2, human_member_id: CREATOR, status: "awaiting_acceptance", created_at: "2" },
      { id: O_IN_PROGRESS, tenant_id: T1, human_member_id: CREATOR, status: "in_progress", created_at: "3" },
      { id: O_SUBMITTED, tenant_id: T2, human_member_id: CREATOR, status: "submitted", created_at: "4" },
      { id: O_COMPLETED, tenant_id: T1, human_member_id: CREATOR, status: "completed", created_at: "5" },
    ],
    brief_applications: [
      { id: "app-1", human_member_id: CREATOR, status: "applied" },
      { id: "app-2", human_member_id: CREATOR, status: "shortlisted" },
      { id: "app-3", human_member_id: CREATOR, status: "approved" },
      { id: "app-4", human_member_id: CREATOR, status: "rejected" },
    ],
    creator_offers: [
      { id: "off-1", human_member_id: CREATOR, status: "open" },
      { id: "off-2", human_member_id: CREATOR, status: "accepted" },
    ],
    human_members: [
      {
        id: CREATOR,
        slug: "ada",
        lanes: ["ugc_video"],
        city: "Austin",
        country_code: "US",
        missed_deadline_count: over.marks ?? 0,
        intro_video_path: "ada/intro.mp4",
        sample_video_paths: ["ada/s1.mp4", "ada/s2.mp4"],
        public_metrics: { tiktok_followers: 48000, instagram_followers: 12000 },
      },
    ],
    human_member_pii: [
      {
        human_member_id: CREATOR,
        date_of_birth: "2001-03-04",
        legal_name: "Ada Lovelace",
        tin_sha256: "\\xdeadbeef",
        payout_ref_hash: "\\xcafebabe",
      },
    ],
    creator_packages: [
      {
        id: "pkg-1",
        human_member_id: CREATOR,
        kind: "ugc_video",
        title: "3 ad videos",
        description: null,
        price_cents: 15_000,
        currency: "usd",
        delivery_days: 7,
        active: true,
        video_count: 3,
        video_length_seconds: 30,
        ad_rights_days: 90,
        addons: [],
      },
    ],
    creator_payout_accounts: [
      {
        human_member_id: CREATOR,
        livemode: false,
        country: "US",
        details_submitted: true,
        payouts_enabled: true,
        disabled_reason: null,
        stripe_account_id: "acct_LEAK",
      },
    ],
  };
  H.state.updates = [];
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
  H.apply.mockImplementation(async (args: any) => ({
    ok: true,
    order: { id: args.order_id, status: "cancelled", closed_reason: "creator_removed" },
    trigger: args.trigger,
    from: "awaiting_acceptance",
    to: "cancelled",
    deadline: null,
    money: [],
    needs_staff_review: false,
    payout_waiting: false,
  }));
  H.audit.mockClear();
  H.setVettingState.mockReset();
  H.setVettingState.mockImplementation(async (id: string, _state: string, reason: string) => ({
    id,
    display_name: "Ada Makes Ads",
    vetting_state: "rejected",
    rejected_reason: reason,
  }));
  H.getMemberDetail.mockReset();
  H.getMemberDetail.mockResolvedValue({
    member: { id: CREATOR, display_name: "Ada Makes Ads", vetting_state: "approved", rejected_reason: null },
    handles: [{ platform: "tiktok", handle: "ada" }],
    pii: { human_member_id: CREATOR, legal_name: "Ada Lovelace", email: "ada@example.test" },
    collisions: [],
  });
});

describe("removal hides the storefront", () => {
  it("rejects the creator with the staff reason, which is what pulls the storefront", async () => {
    const res = mockRes();
    await staffCreatorRemove(staffReq({ body: { reason: "samples were not their own work" } }), res);

    expect(res.statusCode).toBe(200);
    expect(H.setVettingState).toHaveBeenCalledWith(
      CREATOR,
      "rejected",
      "samples were not their own work",
    );
    expect(res.payload.cascade.storefront_hidden).toBe(true);
    expect(res.payload.member.rejected_reason).toBe("samples were not their own work");
  });

  it("refuses a removal with no reason, and changes nothing", async () => {
    for (const body of [{}, { reason: "" }, { reason: "   " }]) {
      H.setVettingState.mockClear();
      H.apply.mockClear();
      const res = mockRes();
      await staffCreatorRemove(staffReq({ body }), res);
      expect(res.statusCode).toBe(400);
      expect(res.payload.error.code).toBe("reason_required");
      expect(H.setVettingState).not.toHaveBeenCalled();
      expect(H.apply).not.toHaveBeenCalled();
    }
  });
});

describe("removal withdraws open applications and open offers", () => {
  it("withdraws only the live applications, never a hired or already-rejected one", async () => {
    const res = mockRes();
    await staffCreatorRemove(staffReq({ body: { reason: "policy" } }), res);

    expect(res.payload.cascade.applications_withdrawn).toBe(2);
    const appUpdate = H.state.updates.find((u) => u.table === "brief_applications");
    expect(appUpdate?.patch.status).toBe("withdrawn");
    expect(appUpdate?.ids.sort()).toEqual(["app-1", "app-2"]);

    const byId = new Map(H.state.tables.brief_applications.map((r) => [r.id, r.status]));
    expect(byId.get("app-3")).toBe("approved");
    expect(byId.get("app-4")).toBe("rejected");
  });

  it("withdraws only OPEN custom offers, so nothing is left to check out", async () => {
    const res = mockRes();
    await staffCreatorRemove(staffReq({ body: { reason: "policy" } }), res);

    expect(res.payload.cascade.offers_withdrawn).toBe(1);
    const offerUpdate = H.state.updates.find((u) => u.table === "creator_offers");
    expect(offerUpdate?.ids).toEqual(["off-1"]);
    const byId = new Map(H.state.tables.creator_offers.map((r) => [r.id, r.status]));
    expect(byId.get("off-2")).toBe("accepted");
  });
});

describe("removal cancels pending requests so their holds release", () => {
  it("runs creator_removed on exactly the two pre-accept orders, each in its own tenant", async () => {
    const res = mockRes();
    await staffCreatorRemove(staffReq({ body: { reason: "policy" } }), res);

    expect(H.apply).toHaveBeenCalledTimes(2);
    const calls = H.apply.mock.calls.map((c: any[]) => c[0]);
    expect(calls.every((c) => c.trigger === "creator_removed")).toBe(true);
    expect(calls.every((c) => c.actor === "staff")).toBe(true);
    expect(calls.every((c) => c.actor_user_id === "staff-1")).toBe(true);
    expect(calls.map((c) => [c.tenant_id, c.order_id]).sort()).toEqual(
      [
        [T1, O_CHECKOUT],
        [T2, O_AWAITING],
      ].sort(),
    );
    expect(res.payload.cascade.pending_orders_cancelled).toHaveLength(2);
    expect(res.payload.cascade.pending_orders_failed).toEqual([]);
  });

  it("reports a pending order that could not be cancelled instead of hiding it", async () => {
    H.apply.mockImplementation(async (args: any) =>
      args.order_id === O_AWAITING
        ? { ok: false, code: "money_needs_staff", message: "already charged" }
        : {
            ok: true,
            order: { id: args.order_id, status: "cancelled", closed_reason: "creator_removed" },
            trigger: args.trigger,
            from: "checkout_pending",
            to: "cancelled",
            deadline: null,
            money: [],
            needs_staff_review: false,
            payout_waiting: false,
          },
    );
    const res = mockRes();
    await staffCreatorRemove(staffReq({ body: { reason: "policy" } }), res);

    expect(res.statusCode).toBe(200);
    expect(res.payload.cascade.pending_orders_cancelled).toHaveLength(1);
    expect(res.payload.cascade.pending_orders_failed).toEqual([
      { tenant_id: T2, order_id: O_AWAITING, status: "awaiting_acceptance", code: "money_needs_staff", message: "already charged" },
    ]);
    expect(res.payload.cascade.storefront_hidden).toBe(true);
  });
});

describe("Q37: in-progress jobs always finish and pay out", () => {
  it("never asks the executor to touch an in-progress, submitted or completed order", async () => {
    await staffCreatorRemove(staffReq({ body: { reason: "policy" } }), mockRes());
    const touched = H.apply.mock.calls.map((c: any[]) => c[0].order_id);
    expect(touched).not.toContain(O_IN_PROGRESS);
    expect(touched).not.toContain(O_SUBMITTED);
    expect(touched).not.toContain(O_COMPLETED);
  });

  it("leaves their rows exactly as they were", async () => {
    await staffCreatorRemove(staffReq({ body: { reason: "policy" } }), mockRes());
    const byId = new Map(H.state.tables.creator_orders.map((r) => [r.id, r.status]));
    expect(byId.get(O_IN_PROGRESS)).toBe("in_progress");
    expect(byId.get(O_SUBMITTED)).toBe("submitted");
    expect(byId.get(O_COMPLETED)).toBe("completed");
    expect(H.state.updates.some((u) => u.table === "creator_orders")).toBe(false);
  });

  it("reports the in-flight jobs it is leaving running, so the action is honest", async () => {
    const res = mockRes();
    await staffCreatorRemove(staffReq({ body: { reason: "policy" } }), res);
    const left = res.payload.cascade.in_progress_untouched;
    expect(left.map((o: any) => o.order_id).sort()).toEqual([O_IN_PROGRESS, O_SUBMITTED].sort());
  });

  it("the statuses removal cancels are exactly the ones S3 allows creator_removed from", () => {
    const fromTable = TRANSITIONS.find((t) => t.trigger === "creator_removed");
    expect(fromTable).toBeDefined();
    expect([...REMOVAL_CANCELS_ORDER_STATUSES].sort()).toEqual([...fromTable!.from].sort());
    expect(REMOVAL_CANCELS_ORDER_STATUSES).not.toContain("in_progress");
    expect(fromTable!.from).not.toContain("in_progress");
  });

  it("removal with nothing pending still hides the storefront and calls no transition", async () => {
    H.state.tables.creator_orders = [
      { id: O_IN_PROGRESS, tenant_id: T1, human_member_id: CREATOR, status: "in_progress", created_at: "3" },
    ];
    const res = mockRes();
    await staffCreatorRemove(staffReq({ body: { reason: "policy" } }), res);
    expect(res.statusCode).toBe(200);
    expect(H.apply).not.toHaveBeenCalled();
    expect(res.payload.cascade.storefront_hidden).toBe(true);
    expect(res.payload.cascade.in_progress_untouched).toHaveLength(1);
  });
});

describe("missed-deadline marks are derived, never hand-set", () => {
  it("shows the count, the threshold and whether the account needs review", async () => {
    seed({ marks: 2 });
    const res = mockRes();
    await staffCreatorDetail(staffReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.payload.creator.marks).toEqual({
      missed_deadline_count: 2,
      needs_staff_review: true,
      threshold: MISSED_DEADLINE_REVIEW_THRESHOLD,
      derived_from: "no_show order transitions",
    });
  });

  it("one mark does not surface the account", async () => {
    seed({ marks: 1 });
    const res = mockRes();
    await staffCreatorDetail(staffReq(), res);
    expect(res.payload.creator.marks.needs_staff_review).toBe(false);
  });

  it("no staff route ever writes missed_deadline_count", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const route = readFileSync(join(__dirname, "..", "creator-network.ts"), "utf8");
    const service = readFileSync(
      join(__dirname, "..", "..", "..", "services", "creators", "staff-console.ts"),
      "utf8",
    );
    for (const src of [route, service]) {
      expect(src).not.toMatch(/\.(update|insert|upsert)\(\s*\{[^}]*missed_deadline_count/s);
    }
    const routeCode = route
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    expect(routeCode).not.toMatch(/missed_deadline_count/);
  });

  it("a removal body carrying missed_deadline_count is refused outright", async () => {
    const res = mockRes();
    await staffCreatorRemove(
      staffReq({ body: { reason: "policy", missed_deadline_count: 0 } }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(H.setVettingState).not.toHaveBeenCalled();
    expect(H.apply).not.toHaveBeenCalled();
  });
});

describe("the vetting view shows the new signup data, and no PII", () => {
  it("carries lanes, intro video, samples, packages and payout eligibility", async () => {
    const res = mockRes();
    await staffCreatorDetail(staffReq(), res);
    const c = res.payload.creator;
    expect(c.lanes).toEqual(["ugc_video"]);
    expect(c.intro_video_path).toBe("ada/intro.mp4");
    expect(c.sample_video_paths).toEqual(["ada/s1.mp4", "ada/s2.mp4"]);
    expect(c.packages).toHaveLength(1);
    expect(c.packages[0].price_cents).toBe(15_000);
    expect(c.country_code).toBe("US");
    expect(c.payout_country_supported).toBe(true);
    expect(c.payout_account).toEqual({
      exists: true,
      livemode: false,
      country: "US",
      details_submitted: true,
      payouts_enabled: true,
      disabled_reason: null,
    });
  });

  it("keeps today's vetting states and collision list alongside it", async () => {
    const res = mockRes();
    await staffCreatorDetail(staffReq(), res);
    expect(res.payload.member.vetting_state).toBe("approved");
    expect(res.payload.handles).toHaveLength(1);
    expect(res.payload.collisions).toEqual([]);
  });

  it("labels every audience number self-reported and never marks it verified", async () => {
    const res = mockRes();
    await staffCreatorDetail(staffReq(), res);
    const a = res.payload.creator.self_reported_audience;
    expect(a.label).toBe("Self-reported, not checked by Zavi");
    expect(a.verified).toBe(false);
    expect(a.metrics.tiktok_followers).toBe(48000);
  });

  it("shows an 18+ boolean, never the date of birth", async () => {
    const res = mockRes();
    await staffCreatorDetail(staffReq(), res);
    expect(res.payload.creator.is_18_plus).toBe(true);
    const serialized = JSON.stringify(res.payload);
    expect(serialized).not.toContain("2001-03-04");
    expect(serialized).not.toContain("date_of_birth");
  });

  it("never leaks a TIN hash, a payout reference or a Stripe account id", async () => {
    const res = mockRes();
    await staffCreatorDetail(staffReq(), res);
    const serialized = JSON.stringify(res.payload);
    expect(findDeniedKeys(JSON.parse(serialized))).toEqual([]);
    expect(serialized).not.toContain("acct_LEAK");
    expect(serialized).not.toContain("deadbeef");
    expect(serialized).not.toContain("cafebabe");
  });

  it("the removal response body is clean too", async () => {
    const res = mockRes();
    await staffCreatorRemove(staffReq({ body: { reason: "policy" } }), res);
    expect(findDeniedKeys(JSON.parse(JSON.stringify(res.payload)))).toEqual([]);
  });
});

describe("under-18 and unreachable-payout creators read honestly", () => {
  it("a creator born 17 years ago reads is_18_plus false", async () => {
    H.state.tables.human_member_pii[0].date_of_birth = "2012-01-01";
    const res = mockRes();
    await staffCreatorDetail(staffReq(), res);
    expect(res.payload.creator.is_18_plus).toBe(false);
  });

  it("a missing date of birth reads null rather than guessing", async () => {
    H.state.tables.human_member_pii = [];
    const res = mockRes();
    await staffCreatorDetail(staffReq(), res);
    expect(res.payload.creator.is_18_plus).toBeNull();
  });

  it("a creator outside Stripe's payout reach is flagged not bookable", async () => {
    H.state.tables.human_members[0].country_code = "IN";
    const res = mockRes();
    await staffCreatorDetail(staffReq(), res);
    expect(res.payload.creator.payout_country_supported).toBe(false);
  });
});
