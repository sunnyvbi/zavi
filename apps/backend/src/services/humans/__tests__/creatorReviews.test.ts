
import { describe, it, expect, beforeEach, vi } from "vitest";

const TENANT_A = "aaaaaaaa-0000-4000-8000-000000000001";
const TENANT_B = "bbbbbbbb-0000-4000-8000-000000000002";
const ORDER_A = "11111111-0000-4000-8000-000000000011";
const ORDER_B = "22222222-0000-4000-8000-000000000022";
const ORDER_LIVE = "33333333-0000-4000-8000-000000000033";
const CREATOR = "99999999-0000-4000-8000-000000000099";
const BUSINESS_USER = "77777777-0000-4000-8000-000000000077";
const CREATOR_USER = "88888888-0000-4000-8000-000000000088";

const NOW_ISO = "2026-08-10T00:00:00.000Z";

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};

function makeQuery(table: string) {
  let rows = [...(db[table] ?? [])];
  const api: Record<string, unknown> = {
    select: () => api,
    order: (col: string, opts?: { ascending?: boolean }) => {
      const dir = opts?.ascending === false ? -1 : 1;
      rows = [...rows].sort((a, b) =>
        String(a[col]) < String(b[col]) ? -dir : String(a[col]) > String(b[col]) ? dir : 0,
      );
      return api;
    },
    eq: (col: string, val: unknown) => {
      rows = rows.filter((r) => r[col] === val);
      return api;
    },
    in: (col: string, vals: unknown[]) => {
      rows = rows.filter((r) => vals.includes(r[col]));
      return api;
    },
    limit: () => Promise.resolve({ data: rows, error: null }),
    maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
    then: (resolve: (v: { data: Row[]; error: null }) => unknown) =>
      resolve({ data: rows, error: null }),
  };
  return api;
}

let nextId = 0;

function tenantScopedTable(table: string, tid: string) {
  return {
    select: () => (makeQuery(table) as { eq: (c: string, v: unknown) => unknown }).eq("tenant_id", tid),
    insert: (row: Row) => {
      const clash =
        table === "creator_reviews" &&
        (db[table] ?? []).some((r) => r.order_id === row.order_id);
      const result = clash
        ? { data: null, error: { code: "23505", message: "duplicate key" } }
        : (() => {
            const stamped = {
              created_at: NOW_ISO,
              updated_at: NOW_ISO,
              ...row,
              tenant_id: tid,
              id: `rev-${++nextId}`,
            };
            db[table] = [...(db[table] ?? []), stamped];
            return { data: { id: stamped.id }, error: null };
          })();
      const api: Record<string, unknown> = {
        select: () => api,
        maybeSingle: () => Promise.resolve(result),
        then: (resolve: (v: unknown) => unknown) => resolve(result),
      };
      return api;
    },
    update: (values: Row) => {
      let scope = tid;
      const api: Record<string, unknown> = {
        eq: (col: string, val: unknown) => {
          if (col === "tenant_id") scope = val as string;
          else {
            db[table] = (db[table] ?? []).map((r) =>
              r[col] === val && r.tenant_id === scope ? { ...r, ...values } : r,
            );
          }
          return api;
        },
        then: (resolve: (v: { error: null }) => unknown) => resolve({ error: null }),
      };
      return api;
    },
  };
}

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: (tid: string) => ({ from: (table: string) => tenantScopedTable(table, tid) }),
  staffCrossTenantClient: (reason: string) => {
    if (!reason || reason.trim().length < 8) throw new Error("reason required");
    return { from: (table: string) => makeQuery(table) };
  },
  globalClient: () => ({ from: (table: string) => makeQuery(table) }),
}));

const loadHumanMemberByAuthUser = vi.fn(async (userId: string) =>
  userId === CREATOR_USER
    ? { id: CREATOR, display_name: "Creator", discipline: "ugc_creator", vetting_state: "approved" }
    : null,
);
vi.mock("@/services/humans/member", () => ({
  loadHumanMemberByAuthUser: (u: string) => loadHumanMemberByAuthUser(u),
}));

import {
  aggregateReviews,
  computeRespondsFastStats,
  deriveBadges,
  displayState,
  exactOverallAverage,
  getReviewForOrder,
  hasRespondsFastBadge,
  hasTopCreatorBadge,
  isWithinEditWindow,
  loadCreatorReputation,
  submitCreatorReview,
  updateCreatorReview,
  REVIEW_EDIT_WINDOW_DAYS,
  RESPONDS_FAST_MIN_REQUESTS,
  RESPONDS_FAST_MIN_SHARE,
} from "@/services/humans/creatorReviews";

const scores = (c: number, t: number, s: number) => ({
  communication: c,
  timeliness: t,
  satisfaction: s,
});

beforeEach(() => {
  nextId = 0;
  db.creator_orders = [
    {
      id: ORDER_A,
      tenant_id: TENANT_A,
      human_member_id: CREATOR,
      status: "completed",
      closed_reason: "approved",
      created_at: "2026-08-01T00:00:00.000Z",
      responded_at: "2026-08-01T02:00:00.000Z",
    },
    {
      id: ORDER_B,
      tenant_id: TENANT_B,
      human_member_id: CREATOR,
      status: "completed",
      closed_reason: "approved",
      created_at: "2026-08-02T00:00:00.000Z",
      responded_at: "2026-08-02T03:00:00.000Z",
    },
    {
      id: ORDER_LIVE,
      tenant_id: TENANT_A,
      human_member_id: CREATOR,
      status: "in_progress",
      closed_reason: null,
      created_at: "2026-08-03T00:00:00.000Z",
      responded_at: "2026-08-03T01:00:00.000Z",
    },
  ];
  db.creator_reviews = [];
  db.tenants = [
    { id: TENANT_A, display_name: "Northwind Coffee" },
    { id: TENANT_B, display_name: "Harbor Skincare" },
  ];
});

describe("aggregates are computed from real rows only", () => {
  it("reports NULL averages and a zero count when there are no reviews", () => {
    const agg = aggregateReviews([]);
    expect(agg).toEqual({
      review_count: 0,
      avg_communication: null,
      avg_timeliness: null,
      avg_satisfaction: null,
      avg_overall: null,
    });
    expect(agg.avg_overall).not.toBe(0);
  });

  it("averages each dimension and the overall across real rows", () => {
    const agg = aggregateReviews([scores(5, 4, 3), scores(4, 4, 4), scores(3, 5, 5)]);
    expect(agg.review_count).toBe(3);
    expect(agg.avg_communication).toBe(4);
    expect(agg.avg_timeliness).toBeCloseTo(4.33, 2);
    expect(agg.avg_satisfaction).toBe(4);
    expect(agg.avg_overall).toBeCloseTo(4.11, 2);
  });

  it("rounds the DISPLAYED average to 2dp", () => {
    expect(aggregateReviews([scores(5, 4, 4)]).avg_overall).toBe(4.33);
  });

  it("thresholds the badge on the EXACT average, not on the rounded one shown", () => {
    const exact = 4.4999;
    expect(Math.round(exact * 100) / 100).toBe(4.5);
    expect(hasTopCreatorBadge({ completed_job_count: 9, exact_overall_average: exact })).toBe(false);
  });

  it("exposes the exact average only when there are rows to average", () => {
    expect(exactOverallAverage([])).toBeNull();
    expect(exactOverallAverage([scores(4, 4, 4)])).toBe(4);
  });
});

describe("display state", () => {
  it("says New to Zavi for zero reviews", () => {
    expect(displayState(aggregateReviews([]))).toBe("new_to_zavi");
  });
  it("says rated as soon as one real review exists", () => {
    expect(displayState(aggregateReviews([scores(1, 1, 1)]))).toBe("rated");
  });
});

describe("Top Creator: 3+ completed jobs AND 4.5+ average", () => {
  const at = 4.5;
  it.each([
    [2, at, false, "one job short"],
    [3, at, true, "exactly at both thresholds"],
    [4, at, true, "above the job threshold"],
    [3, 4.49, false, "just under the rating threshold"],
    [3, 4.51, true, "just over the rating threshold"],
  ])("jobs=%s avg=%s -> %s (%s)", (jobs, avg, expected) => {
    expect(
      hasTopCreatorBadge({ completed_job_count: jobs as number, exact_overall_average: avg as number }),
    ).toBe(expected);
  });

  it("is never awarded when there is no rating at all", () => {
    expect(hasTopCreatorBadge({ completed_job_count: 50, exact_overall_average: null })).toBe(false);
  });
});

describe("Responds Fast: enough answered requests, most of them inside 24h", () => {
  const stats = (counted: number, fast: number) => ({
    computable: counted > 0,
    requests_counted: counted,
    answered_within_window: fast,
    share_within_window: counted === 0 ? null : fast / counted,
  });

  it("is not awarded below the minimum request count, even at 100%", () => {
    expect(hasRespondsFastBadge(stats(RESPONDS_FAST_MIN_REQUESTS - 1, RESPONDS_FAST_MIN_REQUESTS - 1))).toBe(false);
  });
  it("is awarded exactly at the minimum request count and share", () => {
    expect(hasRespondsFastBadge(stats(5, 4))).toBe(true);
    expect(RESPONDS_FAST_MIN_SHARE).toBe(0.8);
  });
  it("is not awarded just under the share threshold", () => {
    expect(hasRespondsFastBadge(stats(4, 3))).toBe(false);
  });
  it("is awarded just over the share threshold", () => {
    expect(hasRespondsFastBadge(stats(10, 9))).toBe(true);
  });
  it("is not awarded when the data does not exist yet", () => {
    expect(hasRespondsFastBadge(stats(0, 0))).toBe(false);
  });
});

describe("Responds Fast is derived from real order timestamps", () => {
  it("counts an answer inside 24h as fast and one outside it as slow", () => {
    const s = computeRespondsFastStats([
      { created_at: "2026-08-01T00:00:00Z", responded_at: "2026-08-01T23:59:00Z", status: "completed", closed_reason: "approved" },
      { created_at: "2026-08-01T00:00:00Z", responded_at: "2026-08-02T06:00:00Z", status: "completed", closed_reason: "approved" },
    ]);
    expect(s).toMatchObject({ requests_counted: 2, answered_within_window: 1, share_within_window: 0.5 });
  });

  it("counts a request that expired unanswered as a miss", () => {
    const s = computeRespondsFastStats([
      { created_at: "2026-08-01T00:00:00Z", responded_at: null, status: "cancelled", closed_reason: "expired" },
    ]);
    expect(s.requests_counted).toBe(1);
    expect(s.answered_within_window).toBe(0);
  });

  it("excludes a request still awaiting an answer rather than calling it slow", () => {
    const s = computeRespondsFastStats([
      { created_at: "2026-08-01T00:00:00Z", responded_at: null, status: "awaiting_acceptance", closed_reason: null },
    ]);
    expect(s.computable).toBe(false);
    expect(s.requests_counted).toBe(0);
    expect(s.share_within_window).toBeNull();
  });

  it("marks itself not computable, rather than 0%, when there is nothing to measure", () => {
    expect(computeRespondsFastStats([])).toMatchObject({
      computable: false,
      share_within_window: null,
    });
    expect(deriveBadges({
      completed_job_count: 10,
      exact_overall_average: 5,
      responds_fast: computeRespondsFastStats([]),
    })).toEqual(["top_creator"]);
  });
});

describe("edit window", () => {
  const created = "2026-08-01T00:00:00.000Z";
  const dayMs = 24 * 60 * 60 * 1000;
  it("is open the day before it closes", () => {
    expect(isWithinEditWindow(created, new Date(Date.parse(created) + 6 * dayMs))).toBe(true);
  });
  it("is open AT the boundary instant", () => {
    expect(
      isWithinEditWindow(created, new Date(Date.parse(created) + REVIEW_EDIT_WINDOW_DAYS * dayMs)),
    ).toBe(true);
  });
  it("is closed one millisecond later", () => {
    expect(
      isWithinEditWindow(created, new Date(Date.parse(created) + REVIEW_EDIT_WINDOW_DAYS * dayMs + 1)),
    ).toBe(false);
  });
});

describe("writing a review", () => {
  const input = { communication: 5, timeliness: 4, satisfaction: 5, body: "  Great work  " };

  it("a business can review its own completed job, and the text is trimmed", async () => {
    const res = await submitCreatorReview({
      tenantId: TENANT_A,
      actorUserId: BUSINESS_USER,
      orderId: ORDER_A,
      input,
    });
    expect(res.ok).toBe(true);
    expect(db.creator_reviews).toHaveLength(1);
    expect(db.creator_reviews[0]).toMatchObject({
      tenant_id: TENANT_A,
      order_id: ORDER_A,
      human_member_id: CREATOR,
      body: "Great work",
      reviewer_user_id: BUSINESS_USER,
    });
  });

  it("refuses a SECOND review of the same order", async () => {
    await submitCreatorReview({ tenantId: TENANT_A, actorUserId: BUSINESS_USER, orderId: ORDER_A, input });
    const second = await submitCreatorReview({
      tenantId: TENANT_A,
      actorUserId: BUSINESS_USER,
      orderId: ORDER_A,
      input: { communication: 1, timeliness: 1, satisfaction: 1 },
    });
    expect(second).toEqual({ ok: false, code: "review_already_exists" });
    expect(db.creator_reviews).toHaveLength(1);
    expect(db.creator_reviews[0]).toMatchObject({ communication: 5 });
  });

  it("maps the racing double-submit (23505) to the same one-per-order answer", async () => {
    db.creator_reviews = [
      { id: "seed", tenant_id: TENANT_B, order_id: ORDER_A, human_member_id: CREATOR, communication: 5, timeliness: 5, satisfaction: 5, body: null, created_at: "2026-08-05T00:00:00Z", updated_at: "2026-08-05T00:00:00Z" },
    ];
    const res = await submitCreatorReview({ tenantId: TENANT_A, actorUserId: BUSINESS_USER, orderId: ORDER_A, input });
    expect(res).toEqual({ ok: false, code: "review_already_exists" });
  });

  it("cannot review ANOTHER tenant's order (reads as not found, not as forbidden)", async () => {
    const res = await submitCreatorReview({
      tenantId: TENANT_A,
      actorUserId: BUSINESS_USER,
      orderId: ORDER_B,
      input,
    });
    expect(res).toEqual({ ok: false, code: "order_not_found" });
    expect(db.creator_reviews).toHaveLength(0);
  });

  it("cannot review a job that is not completed", async () => {
    const res = await submitCreatorReview({
      tenantId: TENANT_A,
      actorUserId: BUSINESS_USER,
      orderId: ORDER_LIVE,
      input,
    });
    expect(res).toEqual({ ok: false, code: "order_not_completed" });
    expect(db.creator_reviews).toHaveLength(0);
  });

  it("a CREATOR cannot write a review", async () => {
    const res = await submitCreatorReview({
      tenantId: TENANT_A,
      actorUserId: CREATOR_USER,
      orderId: ORDER_A,
      input,
    });
    expect(res).toEqual({ ok: false, code: "creator_cannot_review" });
    expect(db.creator_reviews).toHaveLength(0);
  });
});

describe("editing a review", () => {
  const input = { communication: 5, timeliness: 5, satisfaction: 5, body: null };

  beforeEach(async () => {
    await submitCreatorReview({ tenantId: TENANT_A, actorUserId: BUSINESS_USER, orderId: ORDER_A, input });
    db.creator_reviews = db.creator_reviews.map((r) => ({
      ...r,
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:00:00.000Z",
    }));
  });

  it("accepts an edit inside the 7-day window", async () => {
    const res = await updateCreatorReview({
      tenantId: TENANT_A,
      orderId: ORDER_A,
      input: { communication: 2, timeliness: 2, satisfaction: 2, body: "changed my mind" },
      now: new Date("2026-08-06T00:00:00.000Z"),
    });
    expect(res.ok).toBe(true);
    expect(db.creator_reviews[0]).toMatchObject({ communication: 2, body: "changed my mind" });
  });

  it("freezes the review after 7 days", async () => {
    const res = await updateCreatorReview({
      tenantId: TENANT_A,
      orderId: ORDER_A,
      input: { communication: 1, timeliness: 1, satisfaction: 1 },
      now: new Date("2026-08-08T00:00:01.000Z"),
    });
    expect(res).toEqual({ ok: false, code: "review_frozen" });
    expect(db.creator_reviews[0]).toMatchObject({ communication: 5 });
  });

  it("cannot edit another tenant's review", async () => {
    const res = await updateCreatorReview({
      tenantId: TENANT_B,
      orderId: ORDER_A,
      input: { communication: 1, timeliness: 1, satisfaction: 1 },
      now: new Date("2026-08-02T00:00:00.000Z"),
    });
    expect(res).toEqual({ ok: false, code: "review_not_found" });
    expect(db.creator_reviews[0]).toMatchObject({ communication: 5 });
  });

  it("reports the edit window on the read", async () => {
    const got = await getReviewForOrder(TENANT_A, ORDER_A, new Date("2026-08-02T00:00:00.000Z"));
    expect(got).toMatchObject({ editable: true, edit_window_ends_at: "2026-08-08T00:00:00.000Z" });
  });
});

describe("creator reputation", () => {
  it("is New to Zavi with no rating and no Top Creator badge when nobody has reviewed", async () => {
    const rep = await loadCreatorReputation(CREATOR);
    expect(rep.display_state).toBe("new_to_zavi");
    expect(rep.aggregates.avg_overall).toBeNull();
    expect(rep.aggregates.review_count).toBe(0);
    expect(rep.reviews).toEqual([]);
    expect(rep.badges).not.toContain("top_creator");
    expect(rep.badges).toEqual(["responds_fast"]);
  });

  it("shows no badges at all for a creator with no reviews and no answered requests", async () => {
    db.creator_orders = [];
    const rep = await loadCreatorReputation(CREATOR);
    expect(rep.badges).toEqual([]);
    expect(rep.responds_fast).toMatchObject({ computable: false, share_within_window: null });
  });

  it("sums reviews across EVERY business that hired the creator, named by business", async () => {
    db.creator_reviews = [
      { id: "r1", tenant_id: TENANT_A, order_id: ORDER_A, human_member_id: CREATOR, communication: 5, timeliness: 5, satisfaction: 5, body: "Nailed it", created_at: "2026-08-05T00:00:00Z", updated_at: "2026-08-05T00:00:00Z" },
      { id: "r2", tenant_id: TENANT_B, order_id: ORDER_B, human_member_id: CREATOR, communication: 4, timeliness: 4, satisfaction: 5, body: null, created_at: "2026-08-06T00:00:00Z", updated_at: "2026-08-06T00:00:00Z" },
    ];
    const rep = await loadCreatorReputation(CREATOR);
    expect(rep.display_state).toBe("rated");
    expect(rep.aggregates.review_count).toBe(2);
    expect(rep.aggregates.avg_overall).toBeCloseTo(4.67, 2);
    expect(rep.reviews.map((r) => r.business_name).sort()).toEqual([
      "Harbor Skincare",
      "Northwind Coffee",
    ]);
    expect(rep.completed_job_count).toBe(2);
    expect(rep.badges).not.toContain("top_creator");
  });

  it("earns Top Creator at exactly 3 completed jobs with a 4.5+ average", async () => {
    db.creator_orders = [...db.creator_orders, {
      id: "44444444-0000-4000-8000-000000000044",
      tenant_id: TENANT_A,
      human_member_id: CREATOR,
      status: "completed",
      closed_reason: "approved",
      created_at: "2026-08-04T00:00:00.000Z",
      responded_at: "2026-08-04T01:00:00.000Z",
    }];
    db.creator_reviews = [
      { id: "r1", tenant_id: TENANT_A, order_id: ORDER_A, human_member_id: CREATOR, communication: 5, timeliness: 5, satisfaction: 4, body: null, created_at: "2026-08-05T00:00:00Z", updated_at: "2026-08-05T00:00:00Z" },
      { id: "r2", tenant_id: TENANT_B, order_id: ORDER_B, human_member_id: CREATOR, communication: 5, timeliness: 4, satisfaction: 5, body: null, created_at: "2026-08-06T00:00:00Z", updated_at: "2026-08-06T00:00:00Z" },
    ];
    const rep = await loadCreatorReputation(CREATOR);
    expect(rep.completed_job_count).toBe(3);
    expect(rep.badges).toContain("top_creator");
    expect(rep.badges).toContain("responds_fast");
  });

  it("never reports another creator's reviews", async () => {
    db.creator_reviews = [
      { id: "r9", tenant_id: TENANT_A, order_id: ORDER_A, human_member_id: "someone-else", communication: 1, timeliness: 1, satisfaction: 1, body: "bad", created_at: "2026-08-05T00:00:00Z", updated_at: "2026-08-05T00:00:00Z" },
    ];
    const rep = await loadCreatorReputation(CREATOR);
    expect(rep.reviews).toEqual([]);
    expect(rep.aggregates.review_count).toBe(0);
  });
});
