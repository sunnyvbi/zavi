import { describe, it, expect, vi, beforeEach } from "vitest";

type Res = { data?: unknown; count?: number | null; error: { message: string } | null };
let results: Record<string, Res | ((filters: string[]) => Res)> = {};
const queries: Array<{ table: string; filters: string[] }> = [];

function builder(table: string) {
  const filters: string[] = [];
  queries.push({ table, filters });
  const q: Record<string, unknown> = {};
  const rec = (op: string) => (c: string, v?: unknown) => (filters.push(`${op}:${c}=${JSON.stringify(v)}`), q);
  for (const op of ["eq", "neq", "in", "is", "order"]) q[op] = rec(op);
  q.select = (_cols: string, opts?: { head?: boolean }) => (opts?.head && filters.push("head"), q);
  q.limit = (n: number) => (filters.push(`limit:${n}`), q);
  q.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => {
    const key = filters.includes("head") ? `${table}#${filters.filter((f) => f !== "head").join("&")}` : table;
    const r = results[key] ?? results[table] ?? { data: [], count: 0, error: null };
    return Promise.resolve(typeof r === "function" ? r(filters) : r).then(ok, bad);
  };
  return q;
}
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({ from: (t: string) => builder(t) }),
}));
const cgoAdBudget = vi.fn();
vi.mock("@/services/growth/cgo-ads", () => ({ cgoAdBudget: (...a: unknown[]) => cgoAdBudget(...a) }));
let dueTests: { due: Array<{ decision_id: string }>; more: number } | Error = { due: [], more: 0 };
const dueCalls = vi.fn();
vi.mock("@/services/growth/cgo-tests", () => ({
  readDueTests: async (...a: unknown[]) => {
    dueCalls(...a);
    if (dueTests instanceof Error) throw dueTests;
    return dueTests;
  },
}));
vi.mock("@/services/growth/goal-owner", () => ({ CGO_CARD_CLASS: "cgo.card" }));

import {
  budgetFact,
  budgetReviewSignature,
  nothingChangedSince,
  readBudgetReviewFacts,
  readLastReview,
  signatureForPayload,
  type BudgetReviewFacts,
} from "../budget-review-signature";
import type { ActiveAdBudget } from "@/services/decisions/ad-budget";

const BUDGET: ActiveAdBudget = {
  id: "b1",
  monthly_usd: 200,
  month_cap_usd: 200,
  spent_usd: 0,
  held_usd: 0,
  creator_held_usd: 0,
  creator_spent_usd: 0,
  left_usd: 200,
  daily_limit_usd: null,
  next_month_start: "2026-11-01",
  days_left: 10,
  days_in_month: 31,
  actual_read_at: "2026-10-22T10:07:00Z",
};

const FACTS: BudgetReviewFacts = {
  budget: budgetFact(BUDGET),
  holds: ["h1:reserved:0:0:1000"],
  cards_open: ["a1", "a2"],
  cards_in_flight: [],
  decisions_open: ["d1"],
  decisions_in_flight: [],
  exec_failed: 0,
  dispatch_failed: 3,
  due_tests: [],
  answered: null,
  plan: "p1:4:2026-10-20T00:00:00Z",
  incidents: ["i1:open", "i2:worsened"],
  ad_change: "c9:2026-10-21T00:00:00Z",
  goals: ["g1:signups:100:2026-12-01"],
  campaigns: ["meta:c1:ACTIVE:daily:2000:null"],
};

beforeEach(() => {
  results = {};
  queries.length = 0;
  cgoAdBudget.mockReset();
  dueTests = { due: [], more: 0 };
  dueCalls.mockReset();
});

describe("budgetReviewSignature", () => {
  it("is stable and ignores the order of incidents and goals", () => {
    const shuffled = { ...FACTS, incidents: [...FACTS.incidents].reverse(), goals: [...FACTS.goals] };
    expect(budgetReviewSignature(shuffled)).toBe(budgetReviewSignature(FACTS));
    expect(budgetReviewSignature(FACTS)).toMatch(/^[0-9a-f]{16}$/);
  });

  it.each<[string, Partial<BudgetReviewFacts>]>([
    ["spend moved", { budget: budgetFact({ ...BUDGET, spent_usd: 0.01 }) }],
    ["a hold was taken", { holds: ["h1:reserved:0:0:1000", "h2:reserved:0:0:500"] }],
    ["a hold was paused", { holds: ["h1:reserved:1:0:1000"] }],
    ["the reserve margin changed", { budget: budgetFact({ ...BUDGET, margin: 1.5 }) }],
    ["the founder changed the amount", { budget: budgetFact({ ...BUDGET, monthly_usd: 300 }) }],
    ["a new month started", { budget: budgetFact({ ...BUDGET, next_month_start: "2026-12-01" }) }],
    ["the budget was replaced", { budget: budgetFact({ ...BUDGET, id: "b2" }) }],
    ["a card opened", { cards_open: ["a1", "a2", "a3"] }],
    ["one card closed as another opened", { cards_open: ["a1", "a3"] }],
    ["a card was approved", { cards_in_flight: ["a1"] }],
    ["a decision opened", { decisions_open: ["d1", "d2"] }],
    ["a test readout fell due", { due_tests: ["t1"] }],
    ["the founder answered a question", { answered: "q1:2026-10-22T09:00:00Z" }],
    ["an exec failed", { exec_failed: 1 }],
    ["a dispatch failed", { dispatch_failed: 4 }],
    ["the plan changed", { plan: "p1:5:2026-10-22T00:00:00Z" }],
    ["an incident worsened", { incidents: ["i1:worsened", "i2:worsened"] }],
    ["an ad was switched", { ad_change: "c10:2026-10-22T00:00:00Z" }],
    ["a goal target changed", { goals: ["g1:signups:150:2026-12-01"] }],
    ["a campaign was paused in the ad account", { campaigns: ["meta:c1:PAUSED:daily:2000:null"] }],
    ["a campaign budget changed", { campaigns: ["meta:c1:ACTIVE:daily:3000:null"] }],
    ["a campaign-level (CBO) budget changed", { campaigns: ["meta:c1:ACTIVE:daily:2000:500"] }],
  ])("changes when %s", (_why, patch) => {
    expect(budgetReviewSignature({ ...FACTS, ...patch })).not.toBe(budgetReviewSignature(FACTS));
  });

  it("does not change on time alone: the spend read's time, days left, money left, held dollars", () => {
    const later = budgetFact({ ...BUDGET, actual_read_at: "2026-10-22T14:07:00Z", days_left: 9, left_usd: 199.5, held_usd: 45 });
    expect(later).toBe(budgetFact(BUDGET));
  });
});

describe("nothingChangedSince", () => {
  it("only a finished review with the same signature excuses a wake", () => {
    expect(nothingChangedSince({ status: "success", signature: "a" }, "a")).toBe(true);
    expect(nothingChangedSince({ status: "success", signature: "b" }, "a")).toBe(false);
    expect(nothingChangedSince({ status: "failed", signature: "a" }, "a")).toBe(false);
    expect(nothingChangedSince({ status: "running", signature: "a" }, "a")).toBe(false);
    expect(nothingChangedSince({ status: "success", signature: null }, "a")).toBe(false);
    expect(nothingChangedSince(null, "a")).toBe(false);
  });
});

describe("readBudgetReviewFacts", () => {
  it("reads every fact for this tenant only and builds the facts", async () => {
    results = {
      growth_plan: { data: [{ id: "p1", version: 4, updated_at: "2026-10-20T00:00:00Z" }], error: null },
      metric_incidents: { data: [{ id: "i1", status: "open" }], error: null },
      ad_budget_reservations: { data: [{ id: "h1", status: "reserved", paused: false, bounded: false, daily_delta_usd: 10 }], error: null },
      cgo_questions: { data: [{ id: "q1", answered_at: "2026-10-22T09:00:00Z" }], error: null },
      ad_object_changes: { data: [{ id: "c9", occurred_at: "2026-10-21T00:00:00Z" }], error: null },
      autopilot_goals: { data: [{ id: "g1", target_metric: "signups", target_value: 100, due_date: "2026-12-01" }], error: null },
      ad_campaigns: { data: [{ platform: "meta", object_id: "c1", status: "ACTIVE", budget_kind: "campaign_level", budget_usd: null, campaign_budget_usd: "20.00" }], error: null },
      'decisions#eq:tenant_id="t1"&in:status=["dispatch_failed","failed"]': { count: 3, error: null },
      channel_actions: (filters) =>
        filters.includes('is:exec_status=null') ? { data: [{ id: "a1" }, { id: "a2" }], error: null } : { data: [], count: 0, error: null },
    };
    dueTests = { due: [{ decision_id: "t1" }], more: 2 };
    const now = new Date("2026-10-22T14:00:00Z");
    const f = await readBudgetReviewFacts("t1", BUDGET, now);
    expect(f).toMatchObject({
      holds: ["h1:reserved:0:0:1000"],
      cards_open: ["a1", "a2"],
      dispatch_failed: 3,
      due_tests: ["t1", "more:2"],
      answered: "q1:2026-10-22T09:00:00Z",
      plan: "p1:4:2026-10-20T00:00:00Z",
      incidents: ["i1:open"],
      ad_change: "c9:2026-10-21T00:00:00Z",
      goals: ["g1:signups:100:2026-12-01"],
      campaigns: ["meta:c1:ACTIVE:campaign_level:null:2000"],
    });
    expect(queries.every((q) => q.filters.includes('eq:tenant_id="t1"'))).toBe(true);
    expect(queries.find((q) => q.table === "metric_incidents")!.filters).toContain('neq:status="recovered"');
    expect(queries.find((q) => q.table === "autopilot_goals")!.filters).toContain('eq:status="active"');
    expect(queries.find((q) => q.table === "ad_budget_reservations")!.filters).toEqual(
      expect.arrayContaining(['eq:budget_id="b1"', 'in:status=["reserved","committed"]']),
    );
    expect(queries.find((q) => q.table === "cgo_questions")!.filters).toContain('eq:status="answered"');
    expect(dueCalls).toHaveBeenCalledWith("t1", "cgo.card", now);
  });

  it("throws when any fact cannot be read (the caller then runs the review)", async () => {
    results = { metric_incidents: { data: null, error: { message: "boom" } } };
    await expect(readBudgetReviewFacts("t1", BUDGET)).rejects.toThrow(/incidents read failed: boom/);
    results = { 'decisions#eq:tenant_id="t1"&in:status=["dispatch_failed","failed"]': { count: null, error: { message: "count down" } } };
    await expect(readBudgetReviewFacts("t1", BUDGET)).rejects.toThrow(/count failed: count down/);
    results = {};
    dueTests = new Error("due tests down");
    await expect(readBudgetReviewFacts("t1", BUDGET)).rejects.toThrow(/due tests down/);
    dueTests = { due: [], more: 0 };
    results = { ad_budget_reservations: { data: Array.from({ length: 501 }, (_, i) => ({ id: `h${i}`, status: "reserved" })), error: null } };
    await expect(readBudgetReviewFacts("t1", BUDGET)).rejects.toThrow(/holds has more than 500 rows/);
    results = { ad_campaigns: { data: Array.from({ length: 1000 }, (_, i) => ({ platform: "meta", object_id: `c${i}` })), error: null } };
    await expect(readBudgetReviewFacts("t1", BUDGET)).rejects.toThrow(/campaigns has more than 999 rows/);
    results = {};
    dueTests = new Error("due tests down");
    await expect(readBudgetReviewFacts("t1", BUDGET)).rejects.toThrow(/due tests down/);
  });
});

describe("readLastReview", () => {
  it("returns the newest goal review's status and signature", async () => {
    results = { agent_runs: { data: [{ status: "success", payload: { stage: "own_goals", budget_signature: "abc" }, enqueued_at: "2026-10-23T05:00:00.000Z" }], error: null } };
    expect(await readLastReview("t1", "own_goals")).toEqual({ status: "success", signature: "abc", enqueued_at: "2026-10-23T05:00:00.000Z" });
    const q = queries.find((x) => x.table === "agent_runs")!;
    expect(q.filters).toEqual(
      expect.arrayContaining(['eq:tenant_id="t1"', 'eq:agent_slug="cgo"', 'eq:payload->>stage="own_goals"', "limit:1"]),
    );
  });

  it("a review without a signature reads as null; no review reads as null", async () => {
    results = { agent_runs: { data: [{ status: "success", payload: {} }], error: null } };
    expect(await readLastReview("t1", "own_goals")).toEqual({ status: "success", signature: null, enqueued_at: null });
    results = { agent_runs: { data: [], error: null } };
    expect(await readLastReview("t1", "own_goals")).toBeNull();
  });

  it("throws on a read error", async () => {
    results = { agent_runs: { data: null, error: { message: "down" } } };
    await expect(readLastReview("t1", "own_goals")).rejects.toThrow(/last review read failed/);
  });
});

describe("signatureForPayload", () => {
  it("is null without a running budget and never throws", async () => {
    cgoAdBudget.mockResolvedValueOnce(null);
    expect(await signatureForPayload("t1", new Date())).toBeNull();
    cgoAdBudget.mockResolvedValueOnce(BUDGET);
    results = { growth_plan: { data: null, error: { message: "down" } } };
    expect(await signatureForPayload("t1", new Date())).toBeNull();
  });

  it("matches the signature the budget wake computes for the same facts", async () => {
    cgoAdBudget.mockResolvedValueOnce(BUDGET);
    const sig = await signatureForPayload("t1", new Date());
    expect(sig).toBe(budgetReviewSignature(await readBudgetReviewFacts("t1", BUDGET)));
  });
});
