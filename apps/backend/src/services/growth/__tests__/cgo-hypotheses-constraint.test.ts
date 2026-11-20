import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
let seq = 0;

class Query {
  private filters: Array<(r: Row) => boolean> = [];
  private op: "select" | "update" | "insert" = "select";
  private patch: Row = {};
  private single = false;
  constructor(private table: string) {}
  select() {
    return this;
  }
  insert(r: Row) {
    this.op = "insert";
    this.patch = r;
    return this;
  }
  update(p: Row) {
    this.op = "update";
    this.patch = p;
    return this;
  }
  eq(c: string, v: unknown) {
    this.filters.push((r) => r[c] === v);
    return this;
  }
  neq(c: string, v: unknown) {
    this.filters.push((r) => r[c] !== v);
    return this;
  }
  in(c: string, vs: unknown[]) {
    this.filters.push((r) => vs.includes(r[c]));
    return this;
  }
  not(c: string, op: string, v: string) {
    if (op !== "cs") throw new Error(`fake not ${op}`);
    const want = JSON.parse(v) as Array<Record<string, unknown>>;
    this.filters.push((r) => !want.every((w) => ((r[c] as Array<Record<string, unknown>>) ?? []).some((e) => Object.entries(w).every(([k, x]) => e[k] === x))));
    return this;
  }
  limit() {
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this;
  }
  then<T>(ok: (v: { data: unknown; error: unknown }) => T) {
    const rows = (db[this.table] ??= []);
    if (this.op === "insert") {
      const r = { id: `h-new-${++seq}`, restates_plan_constraint: false, evidence: [], ...this.patch };
      rows.push(r);
      return Promise.resolve({ data: this.single ? { id: r.id } : [r], error: null }).then(ok);
    }
    const hit = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.op === "update") for (const r of hit) Object.assign(r, this.patch);
    return Promise.resolve({ data: this.single ? (hit[0] ?? null) : hit.map((r) => ({ ...r })), error: null }).then(ok);
  }
}

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({ from: (t: string) => new Query(t) }),
}));

import { appendEvidence, claimResearch, clearPlanConstraintMarks, hypothesisViews, planHypotheses, prepareHypotheses, saveHypotheses, type HypothesisRow } from "../cgo-hypotheses";

const T = "tenant-a";
const G = "11111111-1111-4111-8111-111111111111";
const G2 = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";

function hyp(over: Row): Row {
  return { tenant_id: T, goal_id: G, problem: "conversion", claim: "x", refute_if: null, rank: 5, status: "listed", evidence: [], evidence_version: 0, expected_gain: null, research_open: false, research_card_id: null, restates_plan_constraint: false, created_at: "2026-09-28T00:00:00Z", status_at: "2026-09-28T00:00:00Z", ...over };
}
const prep = (proposed: unknown[]) =>
  prepareHypotheses({ tenant_id: T, run_id: RUN, proposed, findings: [], goals: [{ id: G }, { id: G2 }] as never, now: new Date("2026-09-29T00:00:00Z") });

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  db.cgo_hypotheses = [];
  db.agent_runs = [];
  seq = 0;
});

describe("restates_plan_constraint", () => {
  it("planHypotheses carries cgo's mark; the last one on a goal wins", () => {
    const existing = [hyp({ id: "h-old" })] as unknown as HypothesisRow[];
    const plan = planHypotheses({
      existing,
      proposed: [
        { goal_id: G, ref: "h-old", problem: "conversion", claim: "x", restates_plan_constraint: true },
        { goal_id: G, ref: "h1", problem: "traffic", claim: "Too few visitors", restates_plan_constraint: true },
        { goal_id: G2, ref: "h2", problem: "offer", claim: "Price too high" },
      ] as never,
      goalIds: new Set([G, G2]),
      finishedRuns: new Map(),
    });
    expect(plan.constraint_marks).toEqual([{ goal_id: G, ref: "h1" }]);
  });

  it("a new hypothesis cgo marks is stored marked; the goal's older mark is cleared, other goals untouched", async () => {
    db.cgo_hypotheses.push(
      hyp({ id: "h-old", restates_plan_constraint: true }),
      hyp({ id: "h-g2", goal_id: G2, restates_plan_constraint: true }),
      hyp({ id: "h-other-tenant", tenant_id: "tenant-b", restates_plan_constraint: true }),
    );
    await prep([{ goal_id: G, ref: "h1", problem: "traffic", claim: "Too few visitors", restates_plan_constraint: true }]);
    const byId = new Map(db.cgo_hypotheses.map((r) => [r.id, r.restates_plan_constraint]));
    expect(byId.get("h-new-1")).toBe(true);
    expect(byId.get("h-old")).toBe(false);
    expect(byId.get("h-g2")).toBe(true);
    expect(byId.get("h-other-tenant")).toBe(true);
  });

  it("a review that marks nothing leaves the existing mark alone; a ruled-out idea CAN be marked (that is the contradiction)", async () => {
    db.cgo_hypotheses.push(hyp({ id: "h-old", restates_plan_constraint: true }), hyp({ id: "h-ruled", status: "ruled_out" }));
    await prep([
      { goal_id: G, ref: "h1", problem: "traffic", claim: "Too few visitors" },
      { goal_id: G, ref: "h-ruled", problem: "conversion", claim: "x", restates_plan_constraint: true },
    ]);
    const byId = new Map(db.cgo_hypotheses.map((r) => [r.id, r.restates_plan_constraint]));
    expect(byId.get("h-ruled")).toBe(true);
    expect(byId.get("h-old")).toBe(false);
    const ruled = db.cgo_hypotheses.find((r) => r.id === "h-ruled")!;
    expect(ruled.status).toBe("ruled_out");
    expect(ruled.plan_constraint_marked_at).toBeTruthy();
  });

  it("re-marking a still-marked row keeps the founder's Keep; marking it afresh after a rewrite drops it", async () => {
    db.cgo_hypotheses.push(
      hyp({ id: "h-kept", status: "ruled_out", restates_plan_constraint: true, plan_kept_at: "2026-10-14T17:00:00Z", plan_kept_by: "u" }),
    );
    await prep([{ goal_id: G, ref: "h-kept", problem: "traffic", claim: "x", restates_plan_constraint: true }]);
    expect(db.cgo_hypotheses.find((r) => r.id === "h-kept")).toMatchObject({ restates_plan_constraint: true, plan_kept_at: "2026-10-14T17:00:00Z" });
    await clearPlanConstraintMarks(T);
    await prep([{ goal_id: G, ref: "h-kept", problem: "traffic", claim: "x", restates_plan_constraint: true }]);
    expect(db.cgo_hypotheses.find((r) => r.id === "h-kept")).toMatchObject({ restates_plan_constraint: true, plan_kept_at: null, plan_kept_by: null });
  });

  it("a new plan clears every mark on the tenant, and only on the tenant", async () => {
    db.cgo_hypotheses.push(
      hyp({ id: "a", restates_plan_constraint: true, status: "ruled_out" }),
      hyp({ id: "b", goal_id: G2, restates_plan_constraint: true }),
      hyp({ id: "c", tenant_id: "tenant-b", restates_plan_constraint: true }),
    );
    await clearPlanConstraintMarks(T);
    expect(db.cgo_hypotheses.map((r) => [r.id, r.restates_plan_constraint])).toEqual([
      ["a", false],
      ["b", false],
      ["c", true],
    ]);
  });

  it("cgo reads which hypothesis it marked", () => {
    const views = hypothesisViews([hyp({ id: "a", restates_plan_constraint: true }), hyp({ id: "b" })] as unknown as HypothesisRow[], G);
    expect(views.find((v) => v.id === "a")?.restates_plan_constraint).toBe(true);
    expect(views.find((v) => v.id === "b")).not.toHaveProperty("restates_plan_constraint");
  });
});

describe("writers never undo the founder's answer (owner call C)", () => {
  it("a re-wording planned before the founder answered never lands on the answered row", async () => {
    db.cgo_hypotheses.push(hyp({ id: "h-1", claim: "old", status: "testing" }));
    const plan = planHypotheses({
      existing: db.cgo_hypotheses.map((r) => ({ ...r })) as unknown as HypothesisRow[],
      proposed: [{ goal_id: G, ref: "h-1", problem: "conversion", claim: "new words", rank: 2 }] as never,
      goalIds: new Set([G]),
      finishedRuns: new Map(),
    });
    Object.assign(db.cgo_hypotheses[0], { status: "confirmed", evidence: [{ kind: "founder", ref: "q1" }] });
    await saveHypotheses(T, RUN, plan);
    expect(db.cgo_hypotheses[0]).toMatchObject({ claim: "old", status: "confirmed" });
    const judged = { at: "t", kind: "cgo_read", ref: "r", excerpt: "e", verdict: "testing", why: "w", quote: "q", checker: "gpt-v3" };
    db.cgo_hypotheses.push(hyp({ id: "h-2", claim: "two", status: "testing", evidence_version: 4, evidence: [judged] }));
    const up = { id: "h-2", claim: "two, better", refute_if: null, rank: 1, from_claim: "two", from_refute_if: null, from_version: 4, from_evidence: [judged] as never };
    await saveHypotheses(T, RUN, { inserts: [], refused: [], updates: [up] });
    expect(db.cgo_hypotheses[1]).toMatchObject({ claim: "two, better", evidence_version: 5, evidence: [{ at: "t", kind: "cgo_read", ref: "r", excerpt: "e" }] });
    expect((db.cgo_hypotheses[1].evidence as Row[])[0].verdict).toBeUndefined();
    await saveHypotheses(T, RUN, { inserts: [], refused: [], updates: [{ ...up, claim: "two, better", from_claim: "two, better", refute_if: "x", from_version: 4 }] });
    expect(db.cgo_hypotheses[1].refute_if).toBeNull();
    await saveHypotheses(T, RUN, { inserts: [], refused: [], updates: [{ ...up, claim: "two, better", from_claim: "two, better", refute_if: "x", from_version: 5 }] });
    expect(db.cgo_hypotheses[1]).toMatchObject({ refute_if: "x", evidence_version: 6 });
  });

  it("an evidence append that lost a race to the founder's answer keeps the answer's status", async () => {
    db.cgo_hypotheses.push(hyp({ id: "h-1", status: "listed", evidence_version: 1 }));
    const asRead = { ...db.cgo_hypotheses[0] } as unknown as HypothesisRow;
    Object.assign(db.cgo_hypotheses[0], { status: "ruled_out", evidence_version: 2, evidence: [{ kind: "founder", ref: "q1", verdict: "ruled_out" }] });
    const out = await appendEvidence(T, asRead, [{ at: "t", kind: "cgo_read", ref: RUN, excerpt: "12 cancellations" }], { status: "testing" });
    expect(out).not.toBeNull();
    expect(db.cgo_hypotheses[0].status).toBe("ruled_out");
    expect((db.cgo_hypotheses[0].evidence as unknown[]).length).toBe(2);
  });

  it("evidence gathered about the old words is dropped when the claim was re-worded since", async () => {
    db.cgo_hypotheses.push(hyp({ id: "h-1", status: "testing", claim: "old", evidence_version: 1 }));
    const asRead = { ...db.cgo_hypotheses[0] } as unknown as HypothesisRow;
    Object.assign(db.cgo_hypotheses[0], { claim: "new", evidence_version: 2 });
    await appendEvidence(T, asRead, [{ at: "t", kind: "cgo_read", ref: RUN, excerpt: "about old" }]);
    expect(db.cgo_hypotheses[0].evidence).toEqual([]);
  });

  it("a research claim never re-opens a hypothesis ruled out, or re-worded, since it was read", async () => {
    db.cgo_hypotheses.push(hyp({ id: "h-1", status: "listed", claim: "c" }));
    const asRead = { ...db.cgo_hypotheses[0] } as unknown as HypothesisRow;
    db.cgo_hypotheses[0].status = "ruled_out";
    expect(await claimResearch(T, asRead)).toBe(false);
    expect(db.cgo_hypotheses[0]).toMatchObject({ status: "ruled_out", research_open: false });
    Object.assign(db.cgo_hypotheses[0], { status: "listed", claim: "c, re-worded" });
    expect(await claimResearch(T, asRead)).toBe(false);
    db.cgo_hypotheses[0].claim = "c";
    expect(await claimResearch(T, asRead)).toBe(true);
    expect(db.cgo_hypotheses[0]).toMatchObject({ status: "testing", research_open: true });
  });
});
