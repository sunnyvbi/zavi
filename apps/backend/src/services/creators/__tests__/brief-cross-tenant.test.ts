
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  claimPendingApplications,
  closeTenantBrief,
  countBoardBriefApplications,
  countBriefApplications,
  listAppliedClosedBriefs,
  listBoardBriefs,
  listBriefApplications,
  loadBoardBrief,
  loadBriefApplication,
  linkBookingToPendingApplication,
  liveBookingsOnBrief,
  loadTenantBrief,
  resolveBriefTenant,
} from "../briefs-db";
import { creatorBoard, hireFromBookedBrief, myApplication, realAutoNoDeps, sendAutomaticNos } from "../brief-applications";
import { creatorVisibleBrief } from "../brief-projection";
import { logEvent } from "@/services/logging/logEvent";

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const BRIEF_A = "aa111111-1111-1111-1111-111111111111";
const BRIEF_B = "bb222222-2222-2222-2222-222222222222";
const APP_A = "a1111111-1111-1111-1111-111111111111";
const CREATOR_1 = "c1111111-1111-1111-1111-111111111111";
const CREATOR_2 = "c2222222-2222-2222-2222-222222222222";

const T0 = "2026-09-11T00:00:00.000Z";

type Row = Record<string, unknown>;

type SeenQuery = { client: string; table: string; select: string; head: boolean; reason?: string };

const db: Record<string, Row[]> = {};
const seen: SeenQuery[] = [];
const faults: { table: string; op: "select" | "update" | "insert" }[] = [];

function seedDb(): void {
  db.creator_briefs = [
    {
      id: BRIEF_A,
      tenant_id: TENANT_A,
      status: "sent",
      title: "A: 3 ad videos",
      angle: "A angle",
      hook: "A hook",
      format: "9:16",
      deliverables: 3,
      rationale: "A's CTR fell 41%",
      evidence: [{ ad_set: "9912" }],
      source_campaign_ref: "a-spring-retarget",
      source_run_id: null,
      budget_usd: 450,
      utm_campaign: "zavi-brief-aaaaaaaaaaaa",
      lane: "ugc_video",
      filters: null,
      delivery_days: 7,
      posted_at: T0,
      answer_by: "2026-09-16T00:00:00.000Z",
      applicant_cap: 20,
      decline_note: "A's private note",
      closed_at: null,
      created_at: T0,
      updated_at: null,
    },
    {
      id: BRIEF_B,
      tenant_id: TENANT_B,
      status: "sent",
      title: "B: one TikTok post",
      angle: "B angle",
      hook: "B hook",
      format: "9:16",
      deliverables: 1,
      rationale: "B's CPA doubled",
      evidence: [],
      source_campaign_ref: "b-always-on",
      source_run_id: null,
      budget_usd: 200,
      utm_campaign: "zavi-brief-bbbbbbbbbbbb",
      lane: "ugc_video",
      filters: null,
      delivery_days: 5,
      posted_at: T0,
      answer_by: "2026-09-16T00:00:00.000Z",
      applicant_cap: 20,
      decline_note: null,
      closed_at: null,
      created_at: T0,
      updated_at: null,
    },
  ];
  db.brief_applications = [
    {
      id: APP_A,
      tenant_id: TENANT_A,
      brief_id: BRIEF_A,
      brief_kind: "creative",
      human_member_id: CREATOR_1,
      status: "applied",
      pitch: "creator 1's private pitch",
      quoted_rate_usd: "150.00",
      created_at: T0,
      updated_at: null,
    },
    {
      id: "a2222222-2222-2222-2222-222222222222",
      tenant_id: TENANT_A,
      brief_id: BRIEF_A,
      brief_kind: "creative",
      human_member_id: CREATOR_2,
      status: "applied",
      pitch: "creator 2's private pitch",
      quoted_rate_usd: "220.00",
      created_at: T0,
      updated_at: null,
    },
  ];
  db.creator_orders = [];
  db.tenants = [
    { id: TENANT_A, display_name: "Northwind Coffee" },
    { id: TENANT_B, display_name: "Southgate Bikes" },
  ];
}

function builder(client: string, table: string, implicitTenant: string | null, reason?: string) {
  const eqs: [string, unknown][] = [];
  const ins: [string, unknown[]][] = [];
  const nulls: [string, boolean][] = [];
  const ors: ((r: Row) => boolean)[] = [];
  let selectList = "";
  let head = false;
  let patch: Row | null = null;
  let insertRow: Row | null = null;

  const match = (r: Row): boolean => {
    if (implicitTenant !== null && r.tenant_id !== undefined && r.tenant_id !== implicitTenant) return false;
    for (const [k, v] of eqs) if (r[k] !== v) return false;
    for (const [k, vs] of ins) if (!vs.includes(r[k] as never)) return false;
    for (const [k, mustBeNull] of nulls) {
      const isNull = r[k] === null || r[k] === undefined;
      if (mustBeNull !== isNull) return false;
    }
    if (!ors.every((f) => f(r))) return false;
    return true;
  };

  const api: Record<string, unknown> = {
    select(list?: string, opts?: { count?: string; head?: boolean }) {
      selectList = list ?? "";
      head = opts?.head === true;
      seen.push({ client, table, select: selectList, head, reason });
      return api;
    },
    insert(row: Row) {
      insertRow = row;
      return api;
    },
    update(p: Row) {
      patch = p;
      return api;
    },
    eq(col: string, v: unknown) {
      eqs.push([col, v]);
      return api;
    },
    neq(col: string, v: unknown) {
      excludes.push([col, v]);
      return api;
    },
    in(col: string, vs: unknown[]) {
      ins.push([col, vs]);
      return api;
    },
    is(col: string, _v: null) {
      nulls.push([col, true]);
      return api;
    },
    not(col: string, _op: string, _v: null) {
      nulls.push([col, false]);
      return api;
    },
    lte() {
      return api;
    },
    or(expr: string) {
      const clauses = expr.match(/[^,(]+(\([^)]*\))?/g) ?? [];
      ors.push((r) =>
        clauses.some((c) => {
          const m = /^([a-z_]+)\.(is|in)\.(.*)$/.exec(c.trim());
          if (!m) return true;
          const [, col, op, arg] = m;
          const v = r[col];
          if (op === "is") return arg === "null" ? v === null || v === undefined : true;
          return arg.replace(/^\(|\)$/g, "").split(",").includes(v as string);
        }),
      );
      return api;
    },
    order() {
      return api;
    },
    limit() {
      return api;
    },
    maybeSingle() {
      return resolve(true);
    },
    single() {
      return resolve(true);
    },
    then(onOk: (v: unknown) => unknown) {
      return Promise.resolve(resolve(false)).then(onOk);
    },
  };
  const excludes: [string, unknown][] = [];

  function hits(): Row[] {
    return (db[table] ?? []).filter(
      (r) => match(r) && !excludes.some(([k, v]) => r[k] === v),
    );
  }

  function resolve(single: boolean): { data: unknown; error: { message: string } | null; count?: number } {
    const op = insertRow ? "insert" : patch ? "update" : "select";
    const fault = faults.findIndex((f) => f.table === table && f.op === op);
    if (fault >= 0) {
      faults.splice(fault, 1);
      return { data: null, error: { message: `${table} ${op} timed out` } };
    }
    if (insertRow) {
      const row: Row = {
        id: `new-${(db[table] ?? []).length + 1}`,
        ...(implicitTenant ? { tenant_id: implicitTenant } : {}),
        ...insertRow,
      };
      (db[table] ??= []).push(row);
      return { data: single ? row : [row], error: null };
    }
    if (patch) {
      const rows = hits();
      for (const r of rows) Object.assign(r, patch);
      return { data: single ? (rows[0] ?? null) : rows, error: null };
    }
    const rows = hits();
    if (head) return { data: null, error: null, count: rows.length };
    return { data: single ? (rows[0] ?? null) : rows, error: null, count: rows.length };
  }

  return api as never;
}

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: (tid: string) => ({
    from: (table: string) => builder("tenantClient", table, tid),
  }),
  globalClient: () => ({ from: (table: string) => builder("globalClient", table, null) }),
  creatorBoardClient: (reason: string) => ({
    from: (table: string) => builder("creatorBoardClient", table, null, reason),
  }),
  creatorAreaClient: (reason: string) => ({
    from: (table: string) => builder("creatorAreaClient", table, null, reason),
  }),
  preTenantRpc: async (name: string, args: Record<string, unknown>) => {
    if (name !== "human_resolve_brief") throw new Error(`unexpected rpc ${name}`);
    const b = (db.creator_briefs ?? []).find((r) => r.id === args.p_brief_id);
    return { data: b ? [{ tenant_id: b.tenant_id, status: b.status }] : [], error: null };
  },
  tenantRpc: async () => ({ data: [], error: null }),
}));

beforeEach(() => {
  seedDb();
  seen.length = 0;
  faults.length = 0;
  vi.mocked(logEvent).mockClear();
});

describe("another business cannot reach this brief's applicants", () => {
  it("lists zero applicants on a brief it does not own", async () => {
    expect(await listBriefApplications(TENANT_A, BRIEF_A)).toHaveLength(2);
    expect(await listBriefApplications(TENANT_B, BRIEF_A)).toEqual([]);
  });

  it("counts zero applications on a brief it does not own", async () => {
    expect(await countBriefApplications(TENANT_A, BRIEF_A)).toBe(2);
    expect(await countBriefApplications(TENANT_B, BRIEF_A)).toBe(0);
  });

  it("cannot load one application by its id", async () => {
    expect(await loadBriefApplication(TENANT_A, APP_A)).not.toBeNull();
    expect(await loadBriefApplication(TENANT_B, APP_A)).toBeNull();
  });

  it("cannot load the brief itself, so ids cannot be probed", async () => {
    expect(await loadTenantBrief(TENANT_A, BRIEF_A)).not.toBeNull();
    expect(await loadTenantBrief(TENANT_B, BRIEF_A)).toBeNull();
  });

  it("cannot close another business's brief", async () => {
    const closed = await closeTenantBrief({
      tenant_id: TENANT_B,
      brief_id: BRIEF_A,
      closed_at: T0,
      status: "filled",
    });
    expect(closed).toBeNull();
    expect(db.creator_briefs?.find((r) => r.id === BRIEF_A)?.closed_at).toBeNull();
  });

  it("cannot decline another business's applicants", async () => {
    const claimed = await claimPendingApplications({ tenant_id: TENANT_B, brief_id: BRIEF_A });
    expect(claimed).toEqual([]);
    expect(db.brief_applications?.every((a) => a.status === "applied")).toBe(true);
  });

  it("CAN do all of that on its own brief", async () => {
    const claimed = await claimPendingApplications({ tenant_id: TENANT_A, brief_id: BRIEF_A });
    expect(claimed).toHaveLength(2);
    const closed = await closeTenantBrief({ tenant_id: TENANT_A, brief_id: BRIEF_A, closed_at: T0 });
    expect(closed).not.toBeNull();
  });
});

describe("a creator cannot read applications", () => {
  it("only ever issues a head-true COUNT against brief_applications on the board", async () => {
    await countBoardBriefApplications([BRIEF_A, BRIEF_B]);
    const appQueries = seen.filter(
      (q) => q.client === "creatorBoardClient" && q.table === "brief_applications",
    );
    expect(appQueries.length).toBeGreaterThan(0);
    for (const q of appQueries) {
      expect(q.head).toBe(true);
      expect(q.select).toBe("id");
      expect(q.select).not.toContain("pitch");
      expect(q.select).not.toContain("quoted_rate_usd");
      expect(q.select).not.toContain("human_member_id");
    }
  });

  it("returns counts and nothing else from that read", async () => {
    const counts = await countBoardBriefApplications([BRIEF_A, BRIEF_B]);
    expect([...counts.values()].every((v) => typeof v === "number")).toBe(true);
    expect(JSON.stringify([...counts])).not.toContain("pitch");
  });

  it("never reads brief_applications through the board client for ROWS", async () => {
    await listBoardBriefs({ lanes: ["ugc_video"] });
    await loadBoardBrief(BRIEF_A);
    const rowReads = seen.filter(
      (q) => q.client === "creatorBoardClient" && q.table === "brief_applications" && !q.head,
    );
    expect(rowReads).toEqual([]);
  });
});

describe("the board crosses tenants by design, and is column-scoped", () => {
  it("shows briefs from BOTH businesses (spec item 15)", async () => {
    const rows = await listBoardBriefs({ lanes: ["ugc_video"] });
    expect(rows.map((r) => r.id).sort()).toEqual([BRIEF_A, BRIEF_B].sort());
  });

  it("never selects a private column, and never select-star", async () => {
    await listBoardBriefs({ lanes: ["ugc_video"] });
    const briefQueries = seen.filter(
      (q) => q.client === "creatorBoardClient" && q.table === "creator_briefs",
    );
    expect(briefQueries.length).toBeGreaterThan(0);
    for (const q of briefQueries) {
      expect(q.select).not.toBe("*");
      for (const denied of [
        "rationale",
        "evidence",
        "source_campaign_ref",
        "source_run_id",
        "utm_campaign",
        "decline_note",
        "tenant_id",
      ]) {
        expect(q.select, `board query selected '${denied}'`).not.toContain(denied);
      }
    }
  });

  it("requires a reason string on every board read, for the CI scan", async () => {
    await listBoardBriefs({ lanes: [] });
    await countBoardBriefApplications([BRIEF_A]);
    for (const q of seen.filter((s) => s.client === "creatorBoardClient")) {
      expect((q.reason ?? "").length).toBeGreaterThan(8);
    }
  });

  it("hands a creator nothing private about either business, end to end", async () => {
    const board = await creatorBoard({ member: { lanes: ["ugc_video"] }, now: new Date(T0) });
    const payload = JSON.stringify(board);
    for (const secret of [
      "A's CTR fell",
      "B's CPA doubled",
      "a-spring-retarget",
      "b-always-on",
      "zavi-brief-",
      "A's private note",
      "creator 1's private pitch",
      "creator 2's private pitch",
      TENANT_A,
      TENANT_B,
    ]) {
      expect(payload, `'${secret}' reached a creator`).not.toContain(secret);
    }
    expect(payload).toContain("Northwind Coffee");
    expect(payload).toContain("Southgate Bikes");
    expect(payload).toContain("A: 3 ad videos");
  });

  it("a draft is not on the board at all", async () => {
    const a = db.creator_briefs?.find((r) => r.id === BRIEF_A);
    if (a) a.posted_at = null;
    const rows = await listBoardBriefs({ lanes: ["ugc_video"] });
    expect(rows.map((r) => r.id)).toEqual([BRIEF_B]);
    expect(await loadBoardBrief(BRIEF_A)).toBeNull();
  });

  it("a brief with no lane recorded is an ad video brief, and a leftover audience post brief never reaches a UGC creator", async () => {
    const a = db.creator_briefs?.find((r) => r.id === BRIEF_A);
    if (a) a.lane = null;
    const b = db.creator_briefs?.find((r) => r.id === BRIEF_B);
    if (b) b.lane = "audience_post";

    expect((await listBoardBriefs({ lanes: ["ugc_video"] })).map((r) => r.id)).toEqual([BRIEF_A]);
    expect((await listBoardBriefs({ lanes: ["audience_post", "ugc_video"] })).map((r) => r.id)).toEqual([BRIEF_A]);

    const board = await creatorBoard({ member: { lanes: ["ugc_video"] }, now: new Date(T0) });
    expect(board.briefs.map((x) => x.id)).toEqual([BRIEF_A]);
    expect(board.briefs.every((x) => x.lane !== ("audience_post" as never))).toBe(true);
  });

  it("a creator left with only the retired audience post lane never sees an ad video brief", async () => {
    const a = db.creator_briefs?.find((r) => r.id === BRIEF_A);
    if (a) a.lane = null;
    expect(await listBoardBriefs({ lanes: ["audience_post"] })).toEqual([]);
  });

  it("a closed brief is not on the board", async () => {
    const a = db.creator_briefs?.find((r) => r.id === BRIEF_A);
    if (a) a.closed_at = T0;
    const rows = await listBoardBriefs({ lanes: ["ugc_video"] });
    expect(rows.map((r) => r.id)).toEqual([BRIEF_B]);
  });

  it("derives a brief's tenant from the database, never from a caller", async () => {
    expect(await resolveBriefTenant(BRIEF_A)).toEqual({ tenant_id: TENANT_A, status: "sent" });
    expect(await resolveBriefTenant("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("projects a board row with no tenant id on it at all", async () => {
    const rows = await listBoardBriefs({ lanes: ["ugc_video"] });
    const projected = creatorVisibleBrief(rows[0]!, { business_name: "X", applicant_count: 0 });
    expect(Object.keys(projected)).not.toContain("tenant_id");
  });
});

describe("a creator's own history on closed briefs", () => {
  function closeA(): void {
    const a = db.creator_briefs?.find((r) => r.id === BRIEF_A);
    if (a) a.closed_at = T0;
  }

  it("returns the closed briefs THIS creator applied to, and nobody else's", async () => {
    closeA();
    expect((await listAppliedClosedBriefs(CREATOR_1)).map((r) => r.id)).toEqual([BRIEF_A]);
    expect(await listAppliedClosedBriefs("c9999999-9999-9999-9999-999999999999")).toEqual([]);
    const appQ = seen.filter((q) => q.client === "creatorAreaClient");
    expect(appQ.every((q) => q.table === "brief_applications" && q.select === "brief_id")).toBe(true);
    expect(appQ.every((q) => (q.reason ?? "").length > 8)).toBe(true);
    for (const q of seen.filter((q) => q.client === "creatorBoardClient" && q.table === "creator_briefs")) {
      for (const denied of ["rationale", "evidence", "decline_note", "tenant_id", "utm_campaign"]) {
        expect(q.select).not.toContain(denied);
      }
    }
  });

  it("an open brief they applied to is not repeated as history", async () => {
    expect(await listAppliedClosedBriefs(CREATOR_1)).toEqual([]);
  });

  it("the board carries applied_closed for the verified member only", async () => {
    closeA();
    const mine = await creatorBoard({ member: { lanes: ["ugc_video"], id: CREATOR_1 }, now: new Date(T0) });
    expect(mine.briefs.map((b) => b.id)).toEqual([BRIEF_B]);
    expect(mine.applied_closed.map((b) => b.id)).toEqual([BRIEF_A]);
    const payload = JSON.stringify(mine);
    expect(payload).not.toContain("A's private note");
    expect(payload).not.toContain("creator 2's private pitch");
    const anon = await creatorBoard({ member: { lanes: ["ugc_video"] }, now: new Date(T0) });
    expect(anon.applied_closed).toEqual([]);
  });
});

describe("myApplication: hired means PAID, and a no carries the business's note", () => {
  it("approved with the checkout still open is not a hire", async () => {
    const app = db.brief_applications!.find((r) => r.id === APP_A)!;
    app.status = "approved";
    db.creator_orders = [
      { id: "o1", tenant_id: TENANT_A, application_id: APP_A, human_member_id: CREATOR_1, status: "checkout_pending", closed_reason: null },
    ];
    const r = await myApplication({ tenant_id: TENANT_A, brief_id: BRIEF_A, human_member_id: CREATOR_1 });
    expect(r?.hired_order_id).toBeNull();
  });

  it("an abandoned checkout is not a hire", async () => {
    db.brief_applications!.find((r) => r.id === APP_A)!.status = "approved";
    db.creator_orders = [
      { id: "o1", tenant_id: TENANT_A, application_id: APP_A, human_member_id: CREATOR_1, status: "cancelled", closed_reason: "checkout_abandoned" },
    ];
    const r = await myApplication({ tenant_id: TENANT_A, brief_id: BRIEF_A, human_member_id: CREATOR_1 });
    expect(r?.hired_order_id).toBeNull();
  });

  it("a checkout cancelled by creator removal (hold released, never charged) is not a hire", async () => {
    db.brief_applications!.find((r) => r.id === APP_A)!.status = "approved";
    db.creator_orders = [
      { id: "o1", tenant_id: TENANT_A, application_id: APP_A, human_member_id: CREATOR_1, status: "cancelled", closed_reason: "creator_removed" },
    ];
    const r = await myApplication({ tenant_id: TENANT_A, brief_id: BRIEF_A, human_member_id: CREATOR_1 });
    expect(r?.hired_order_id).toBeNull();
  });

  it("a charged job cancelled later still reads as a hire, with its status", async () => {
    db.brief_applications!.find((r) => r.id === APP_A)!.status = "approved";
    db.creator_orders = [
      { id: "o1", tenant_id: TENANT_A, application_id: APP_A, human_member_id: CREATOR_1, status: "cancelled", closed_reason: "no_show" },
    ];
    const r = await myApplication({ tenant_id: TENANT_A, brief_id: BRIEF_A, human_member_id: CREATOR_1 });
    expect(r?.hired_order_id).toBe("o1");
    expect(r?.hired_order_status).toBe("cancelled");
  });

  it("a charged hire returns its order id", async () => {
    db.brief_applications!.find((r) => r.id === APP_A)!.status = "approved";
    db.creator_orders = [
      { id: "o1", tenant_id: TENANT_A, application_id: APP_A, human_member_id: CREATOR_1, status: "in_progress", closed_reason: null },
    ];
    const r = await myApplication({ tenant_id: TENANT_A, brief_id: BRIEF_A, human_member_id: CREATOR_1 });
    expect(r?.hired_order_id).toBe("o1");
    expect(r?.business_note).toBeNull();
  });

  it("a rejected application carries the note the business sent", async () => {
    db.brief_applications!.find((r) => r.id === APP_A)!.status = "rejected";
    const r = await myApplication({ tenant_id: TENANT_A, brief_id: BRIEF_A, human_member_id: CREATOR_1 });
    expect(r?.business_note).toBe("A's private note");
    expect(r?.hired_order_id).toBeNull();
  });
});

describe("a package booked from a brief makes the creator's application the hire", () => {
  const ORDER_P = "0d111111-1111-1111-1111-111111111111";
  const booking = (status = "in_progress") => ({
    id: ORDER_P,
    tenant_id: TENANT_A,
    human_member_id: CREATOR_1,
    source: "booking",
    brief_id: BRIEF_A,
    application_id: null,
    status,
    closed_reason: null,
  });
  const appOf = (member: string) => db.brief_applications!.find((r) => r.human_member_id === member)!;
  const briefA = () => db.creator_briefs!.find((r) => r.id === BRIEF_A)!;
  const nosDeps = (sent: string[]) => ({
    loadBrief: loadTenantBrief,
    closeBrief: closeTenantBrief,
    claim: claimPendingApplications,
    liveBookings: liveBookingsOnBrief,
    relinkBooking: linkBookingToPendingApplication,
    businessName: async () => "Northwind Coffee",
    notify: (async (a: { recipient: { human_member_id: string } }) => {
      sent.push(a.recipient.human_member_id);
      return { written: true, emailed: true };
    }) as never,
  });

  it("approves that creator's application, fills the brief with this order, and the creator now reads Hired", async () => {
    db.creator_orders = [booking()];
    expect((await myApplication({ tenant_id: TENANT_A, brief_id: BRIEF_A, human_member_id: CREATOR_1 }))?.hired_order_id).toBeNull();

    const linked = await linkBookingToPendingApplication({ tenant_id: TENANT_A, brief_id: BRIEF_A, order_id: ORDER_P, human_member_id: CREATOR_1 });

    expect(linked).toEqual({ application_id: APP_A, filled_brief: true });
    expect(appOf(CREATOR_1).status).toBe("approved");
    expect(appOf(CREATOR_2).status).toBe("applied");
    expect(briefA().status).toBe("filled");
    expect(briefA().filled_by_order_id).toBe(ORDER_P);
    expect(db.creator_orders![0].application_id).toBe(APP_A);
    const mine = await myApplication({ tenant_id: TENANT_A, brief_id: BRIEF_A, human_member_id: CREATOR_1 });
    expect(mine?.hired_order_id).toBe(ORDER_P);
    expect(mine?.hired_order_status).toBe("in_progress");
  });

  it("another business cannot link a booking to this brief", async () => {
    db.creator_orders = [booking()];
    const linked = await linkBookingToPendingApplication({ tenant_id: TENANT_B, brief_id: BRIEF_A, order_id: ORDER_P, human_member_id: CREATOR_1 });
    expect(linked).toBeNull();
    expect(appOf(CREATOR_1).status).toBe("applied");
    expect(briefA().closed_at).toBeNull();
    expect(db.creator_orders![0].application_id).toBeNull();
  });

  it("a brief someone else already filled stays theirs, but this creator still reads Hired on their own booking", async () => {
    db.creator_orders = [booking()];
    Object.assign(briefA(), { closed_at: T0, status: "filled", filled_by_order_id: "other-order" });
    const linked = await linkBookingToPendingApplication({ tenant_id: TENANT_A, brief_id: BRIEF_A, order_id: ORDER_P, human_member_id: CREATOR_1 });
    expect(linked).toEqual({ application_id: APP_A, filled_brief: false });
    expect(briefA().filled_by_order_id).toBe("other-order");
    expect((await myApplication({ tenant_id: TENANT_A, brief_id: BRIEF_A, human_member_id: CREATOR_1 }))?.hired_order_id).toBe(ORDER_P);
  });

  it("a creator who never applied to the brief does not close it", async () => {
    const OTHER = "c3333333-3333-3333-3333-333333333333";
    db.creator_orders = [{ ...booking(), human_member_id: OTHER }];
    const linked = await linkBookingToPendingApplication({ tenant_id: TENANT_A, brief_id: BRIEF_A, order_id: ORDER_P, human_member_id: OTHER });
    expect(linked).toBeNull();
    expect(briefA().closed_at).toBeNull();
  });

  it("the answer-by no skips a creator whose booking is waiting on their accept, and their late accept still reads Hired", async () => {
    db.creator_orders = [booking("awaiting_acceptance")];
    const sent: string[] = [];
    const res = await sendAutomaticNos({ tenant_id: TENANT_A, brief_id: BRIEF_A, cause: "answer_by" }, nosDeps(sent));
    expect(res.declined).toBe(1);
    expect(sent).toEqual([CREATOR_2]);
    expect(appOf(CREATOR_1).status).toBe("applied");
    expect(appOf(CREATOR_2).status).toBe("rejected");

    db.creator_orders![0].status = "in_progress";
    const linked = await linkBookingToPendingApplication({ tenant_id: TENANT_A, brief_id: BRIEF_A, order_id: ORDER_P, human_member_id: CREATOR_1 });
    expect(linked).toEqual({ application_id: APP_A, filled_brief: true });
    expect((await myApplication({ tenant_id: TENANT_A, brief_id: BRIEF_A, human_member_id: CREATOR_1 }))?.hired_order_id).toBe(ORDER_P);
  });

  it.each(["in_progress", "submitted", "revision_requested", "completed"])(
    "the answer-by no hires, never rejects, a creator whose accepted booking (%s) is not linked to their application yet",
    async (status) => {
      db.creator_orders = [booking(status)];
      const sent: string[] = [];
      await sendAutomaticNos({ tenant_id: TENANT_A, brief_id: BRIEF_A, cause: "answer_by" }, nosDeps(sent));
      expect(sent).toEqual([CREATOR_2]);
      expect(appOf(CREATOR_1).status).toBe("approved");
      expect(db.creator_orders![0].application_id).toBe(APP_A);
      expect(briefA().filled_by_order_id).toBe(ORDER_P);
    },
  );

  it("a cancelled booking does not protect the creator from the answer-by no", async () => {
    db.creator_orders = [booking("cancelled")];
    const sent: string[] = [];
    await sendAutomaticNos({ tenant_id: TENANT_A, brief_id: BRIEF_A, cause: "answer_by" }, nosDeps(sent));
    expect(sent.sort()).toEqual([CREATOR_1, CREATOR_2].sort());
    expect(appOf(CREATOR_1).status).toBe("rejected");
  });

  it("hiring another applicant does not tell a creator with a live booking on the brief that they were not picked", async () => {
    db.creator_orders = [booking("awaiting_acceptance")];
    const app2 = appOf(CREATOR_2);
    app2.status = "approved";
    const sent: string[] = [];
    await sendAutomaticNos({ tenant_id: TENANT_A, brief_id: BRIEF_A, cause: "hire", hired_application_id: app2.id as string }, nosDeps(sent));
    expect(sent).toEqual([]);
    expect(appOf(CREATOR_1).status).toBe("applied");
  });
});

describe("a paid booking whose brief link fails is never auto-rejected, and the link lands on a retry", () => {
  const ORDER_P = "0d222222-2222-2222-2222-222222222222";
  const paidBooking = (status = "in_progress") => ({
    id: ORDER_P,
    tenant_id: TENANT_A,
    human_member_id: CREATOR_1,
    source: "booking",
    brief_id: BRIEF_A,
    application_id: null,
    status,
    closed_reason: null,
  });
  const appOf = (member: string) => db.brief_applications!.find((r) => r.human_member_id === member)!;
  const briefA = () => db.creator_briefs!.find((r) => r.id === BRIEF_A)!;
  const order = () => db.creator_orders!.find((r) => r.id === ORDER_P)!;
  const nosDeps = (sent: string[]) => ({
    ...realAutoNoDeps,
    businessName: async () => "Northwind Coffee",
    notify: (async (a: { recipient: { human_member_id: string } }) => {
      sent.push(a.recipient.human_member_id);
      return { written: true, emailed: true };
    }) as never,
  });
  const hire = (sent: string[]) =>
    hireFromBookedBrief(
      { tenant_id: TENANT_A, brief_id: BRIEF_A, order_id: ORDER_P, human_member_id: CREATOR_1 },
      { link: linkBookingToPendingApplication, nos: (a) => sendAutomaticNos(a, nosDeps(sent)) },
    );
  const answerBy = (sent: string[]) => sendAutomaticNos({ tenant_id: TENANT_A, brief_id: BRIEF_A, cause: "answer_by" }, nosDeps(sent));
  const hiredOrder = async () =>
    (await myApplication({ tenant_id: TENANT_A, brief_id: BRIEF_A, human_member_id: CREATOR_1 }))?.hired_order_id ?? null;

  it("a link that died after approving the application lands on the retry, fills the brief and tells the others", async () => {
    db.creator_orders = [paidBooking()];
    faults.push({ table: "creator_orders", op: "update" });
    const sent: string[] = [];

    await expect(hire(sent)).rejects.toThrow(/timed out/);
    expect(appOf(CREATOR_1).status).toBe("approved");
    expect(order().application_id).toBeNull();
    expect(await hiredOrder()).toBeNull();

    expect(await hire(sent)).toBe(APP_A);
    expect(order().application_id).toBe(APP_A);
    expect(briefA().filled_by_order_id).toBe(ORDER_P);
    expect(briefA().status).toBe("filled");
    expect(appOf(CREATOR_2).status).toBe("rejected");
    expect(sent).toEqual([CREATOR_2]);
    expect(await hiredOrder()).toBe(ORDER_P);
  });

  it("a link that died after tying the order still fills the brief and sends the nos on the retry", async () => {
    db.creator_orders = [paidBooking()];
    faults.push({ table: "creator_briefs", op: "update" });
    const sent: string[] = [];

    await expect(hire(sent)).rejects.toThrow(/timed out/);
    expect(order().application_id).toBe(APP_A);
    expect(briefA().closed_at).toBeNull();
    expect(sent).toEqual([]);

    expect(await hire(sent)).toBe(APP_A);
    expect(briefA().filled_by_order_id).toBe(ORDER_P);
    expect(sent).toEqual([CREATOR_2]);
    expect(appOf(CREATOR_1).status).toBe("approved");
  });

  it("a retry after the link fully landed is a no-op: nobody is told twice", async () => {
    db.creator_orders = [paidBooking()];
    const sent: string[] = [];
    expect(await hire(sent)).toBe(APP_A);
    expect(await hire(sent)).toBe(APP_A);
    expect(sent).toEqual([CREATOR_2]);
    expect(appOf(CREATOR_1).status).toBe("approved");
  });

  it("the answer-by no after a failed link approves the paid creator instead of rejecting them, and lands the link", async () => {
    db.creator_orders = [paidBooking()];
    faults.push({ table: "brief_applications", op: "update" });
    const sent: string[] = [];
    await expect(hire(sent)).rejects.toThrow(/timed out/);
    expect(appOf(CREATOR_1).status).toBe("applied");

    await answerBy(sent);

    expect(appOf(CREATOR_1).status).toBe("approved");
    expect(appOf(CREATOR_2).status).toBe("rejected");
    expect(sent).toEqual([CREATOR_2]);
    expect(order().application_id).toBe(APP_A);
    expect(briefA().filled_by_order_id).toBe(ORDER_P);
    expect(await hiredOrder()).toBe(ORDER_P);
  });

  it("when the re-link fails again inside the answer-by no, the paid creator is still not rejected and the failure is logged", async () => {
    db.creator_orders = [paidBooking("submitted")];
    faults.push({ table: "brief_applications", op: "update" }, { table: "brief_applications", op: "update" });
    const sent: string[] = [];
    await expect(hire(sent)).rejects.toThrow(/timed out/);

    await answerBy(sent);

    expect(appOf(CREATOR_1).status).toBe("applied");
    expect(appOf(CREATOR_2).status).toBe("rejected");
    expect(sent).toEqual([CREATOR_2]);
    const logged = vi.mocked(logEvent).mock.calls.map(([e]) => e).find((e) => e.code === "booking_link_failed");
    expect(logged?.level).toBe("error");
    expect(logged?.meta).toEqual({ brief_id: BRIEF_A, creator_order_id: ORDER_P });

    expect(await hire(sent)).toBe(APP_A);
    expect(order().application_id).toBe(APP_A);
    expect(await hiredOrder()).toBe(ORDER_P);
  });

  it("a booking lookup that fails leaves the brief open and rejects nobody, so the next answer-by pass can still act", async () => {
    db.creator_orders = [paidBooking()];
    faults.push({ table: "creator_orders", op: "select" });
    const sent: string[] = [];

    await expect(answerBy(sent)).rejects.toThrow(/timed out/);
    expect(briefA().closed_at).toBeNull();
    expect(appOf(CREATOR_1).status).toBe("applied");
    expect(appOf(CREATOR_2).status).toBe("applied");
    expect(sent).toEqual([]);

    await answerBy(sent);
    expect(appOf(CREATOR_1).status).toBe("approved");
    expect(sent).toEqual([CREATOR_2]);
  });

  it("a booking waiting on the creator's accept is protected but not linked: nothing was captured yet", async () => {
    db.creator_orders = [paidBooking("awaiting_acceptance")];
    const sent: string[] = [];
    await answerBy(sent);
    expect(appOf(CREATOR_1).status).toBe("applied");
    expect(order().application_id).toBeNull();
    expect(sent).toEqual([CREATOR_2]);
  });

  it("never re-links onto an application another live hire already holds", async () => {
    appOf(CREATOR_1).status = "approved";
    db.creator_orders = [
      paidBooking(),
      { id: "o-applicant", tenant_id: TENANT_A, human_member_id: CREATOR_1, source: "applicant", brief_id: BRIEF_A, application_id: APP_A, status: "in_progress", closed_reason: null },
    ];
    const linked = await linkBookingToPendingApplication({ tenant_id: TENANT_A, brief_id: BRIEF_A, order_id: ORDER_P, human_member_id: CREATOR_1 });
    expect(linked).toBeNull();
    expect(order().application_id).toBeNull();
    expect(briefA().closed_at).toBeNull();
    expect(appOf(CREATOR_2).status).toBe("applied");
  });
});
