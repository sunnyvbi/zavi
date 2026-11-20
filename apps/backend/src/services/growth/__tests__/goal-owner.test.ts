import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const logEvents: Array<{ source: string; code?: string; meta?: unknown }> = [];
vi.mock("@/services/logging/logEvent", async (orig) => ({
  ...((await orig()) as object),
  logEvent: async (e: { source: string; code?: string; meta?: unknown }) => {
    logEvents.push(e);
  },
}));

vi.mock("../cgo-hypotheses", async (orig) => ({
  ...((await orig()) as object),
  prepareHypotheses: async () => ({ rows: [], gate: undefined as never, refused: [], dropped: 0 }),
  refreshHypotheses: async () => [],
}));

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
const rpcCalls: Array<{ fn: string; args: Row }> = [];
const failReads = new Set<string>();
let rpcResult: Record<string, unknown> = {};

function field(row: Row, col: string): unknown {
  const m = /^(\w+)->>(\w+)$/.exec(col);
  if (m) {
    const obj = row[m[1]] as Row | null | undefined;
    const v = obj?.[m[2]];
    return v == null ? null : String(v);
  }
  return row[col];
}

class Query {
  private filters: Array<(r: Row) => boolean> = [];
  private op: "select" | "update" | "insert" = "select";
  private patch: Row = {};
  private single = false;
  private head = false;
  private selected = "";
  private lim = Infinity;
  constructor(private table: string) {}
  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    this.selected = _cols ?? "";
    if (opts?.head) this.head = true;
    return this;
  }
  update(patch: Row) {
    this.op = "update";
    this.patch = patch;
    return this;
  }
  insert(row: Row | Row[]) {
    this.op = "insert";
    this.patch = Array.isArray(row) ? row[0] : row;
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this;
  }
  neq(col: string, v: unknown) {
    this.filters.push((r) => field(r, col) != null && field(r, col) !== v);
    return this;
  }
  not(col: string, _op: string, v: unknown) {
    this.filters.push((r) => (field(r, col) ?? null) !== v);
    return this;
  }
  eq(col: string, v: unknown) {
    this.filters.push((r) => field(r, col) === v);
    return this;
  }
  is(col: string, v: unknown) {
    this.filters.push((r) => (field(r, col) ?? null) === v);
    return this;
  }
  in(col: string, vs: unknown[]) {
    this.filters.push((r) => vs.includes(field(r, col)));
    return this;
  }
  gte(col: string, v: string) {
    this.filters.push((r) => String(field(r, col) ?? "") >= v);
    return this;
  }
  like(col: string, pattern: string) {
    const re = new RegExp(`^${pattern.split("%").map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    this.filters.push((r) => re.test(String(field(r, col) ?? "")));
    return this;
  }
  lte(col: string, v: string) {
    this.filters.push((r) => String(field(r, col) ?? "") <= v);
    return this;
  }
  gt(col: string, v: string) {
    this.filters.push((r) => field(r, col) != null && String(field(r, col)) > v);
    return this;
  }
  or(expr: string) {
    const parts = expr.split(",").map((p) => p.split("."));
    this.filters.push((r) =>
      parts.some(([col, op, ...rest]) => {
        const v = rest.join(".");
        if (op === "not" && v === "is.null") return (field(r, col) ?? null) !== null;
        if (op === "neq" && v === "{}") return Array.isArray(field(r, col)) && (field(r, col) as unknown[]).length > 0;
        if (op === "is") return (field(r, col) ?? null) === null;
        if (op === "eq" && v === "true") return field(r, col) === true;
        if (op === "gte") return field(r, col) != null && String(field(r, col)) >= v;
        return field(r, col) !== v;
      }),
    );
    return this;
  }
  private sortBy: { col: string; asc: boolean } | null = null;
  order(col?: string, opts?: { ascending?: boolean }) {
    if (col && this.table === "cgo_notes") this.sortBy = { col, asc: opts?.ascending !== false };
    return this;
  }
  limit(n: number) {
    this.lim = n;
    return this;
  }
  filter(col: string, op: string, v: string) {
    if (op !== "cs") throw new Error(`fake filter op ${op}`);
    const want = JSON.parse(v) as Row[];
    this.filters.push((r) => {
      const have = field(r, col);
      return Array.isArray(have) && want.every((w) => (have as Row[]).some((h) => Object.entries(w).every(([k, x]) => h?.[k] === x)));
    });
    return this;
  }
  then<T1, T2>(ok?: ((v: { data: unknown; error: null; count?: number }) => T1) | null, bad?: ((e: unknown) => T2) | null) {
    if (this.op === "select" && (failReads.has(this.table) || (failReads.has(`${this.table}.items`) && !this.selected.startsWith("id, items")))) {
      return Promise.resolve({ data: null, error: { message: `${this.table} read failed` } as never }).then(ok, bad);
    }
    if (this.table === "tenant_subscriptions") {
      if (tenantTier === "throw") return Promise.resolve({ data: null, error: { message: "tier read failed" } as never }).then(ok, bad);
      return Promise.resolve({ data: { tier: tenantTier, status: "active", comp_expires_at: null }, error: null }).then(ok, bad);
    }
    if (this.op === "insert") {
      const row = { id: `${this.table}-${(db[this.table] ?? []).length + 1}`, created_at: new Date().toISOString(), ...this.patch };
      (db[this.table] ??= []).push(row);
      return Promise.resolve({ data: this.single ? row : [row], error: null }).then(ok, bad);
    }
    const rows = (db[this.table] ?? []).filter((r) => this.filters.every((f) => f(r)));
    if (this.op === "update") {
      for (const r of rows) Object.assign(r, this.patch);
      return Promise.resolve({ data: rows, error: null }).then(ok, bad);
    }
    if (this.sortBy) {
      const { col, asc } = this.sortBy;
      rows.sort((a, b) => (String(a[col] ?? "") < String(b[col] ?? "") ? -1 : String(a[col] ?? "") > String(b[col] ?? "") ? 1 : 0) * (asc ? 1 : -1));
    }
    const out = rows.slice(0, this.lim);
    const data = this.head ? null : this.single ? (out[0] ?? null) : out;
    return Promise.resolve({ data, error: null, count: rows.length }).then(ok, bad);
  }
}

function fakeWriteGoal(a: Row): { data: unknown; error: { message: string } | null } {
  if (a.p_actor_source === "cgo" && (!a.p_run_id || !String(a.p_why ?? "").trim())) {
    return { data: null, error: { message: "write_autopilot_goal: a cgo write needs its run and why" } };
  }
  const rows = (db.autopilot_goals ??= []);
  if (a.p_op === "insert") {
    const row = { id: `autopilot_goals-${rows.length + 1}`, tenant_id: a.p_tenant_id, ...(a.p_values as Row) };
    rows.push(row);
    return { data: { status: "written", id: row.id }, error: null };
  }
  const same = (x: unknown, y: unknown) => (x ?? null) === (y ?? null) || (x != null && y != null && Number(x) === Number(y) && typeof x !== "string");
  const hit = rows.find(
    (r) =>
      r.id === a.p_goal_id &&
      r.tenant_id === a.p_tenant_id &&
      Object.entries((a.p_expect as Row | null) ?? {}).every(([k, v]) => same(r[k], v)) &&
      !((a.p_status_not_in as string[] | null) ?? []).includes(String(r.status)),
  );
  if (!hit) return { data: { status: "not_matched", id: null }, error: null };
  if (a.p_op === "delete") rows.splice(rows.indexOf(hit), 1);
  else Object.assign(hit, a.p_values as Row);
  return { data: { status: "written", id: hit.id }, error: null };
}

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (t: string) => new Query(t),
    rpc: async (fn: string, args: Row) => {
      rpcCalls.push({ fn, args });
      if (fn === "write_autopilot_goal") return fakeWriteGoal(args);
      if (fn === "ad_budget_month_view") return { data: monthViewOf(db.ad_budgets, args.p_tenant_id), error: null };
      if (rpcResult[fn] instanceof Error) return { data: null, error: { message: (rpcResult[fn] as Error).message } };
      return { data: rpcResult[fn] ?? null, error: null };
    },
  }),
}));

const visible = new Set(["reddit_organic", "seo", "meta_ads", "engineer", "email_marketing", "research", "pm", "content-design", "operator", "cgo", "chief-of-staff"]);
vi.mock("@/services/agents/visibility", () => ({ getVisibleAgentSlugs: async () => visible }));
let autopilotOn = true;
vi.mock("@/services/settings", () => ({
  getBoolSettingStrictResolved: async (key: string) => (key === "cgo_autopilot_enabled" ? autopilotOn : false),
}));
const enqueueAgentRun = vi.fn();
vi.mock("@/services/agents/runner", () => ({ enqueueAgentRun: (...a: unknown[]) => enqueueAgentRun(...a) }));
let tenantTier: string = "pro";

import {
  budgetContextDegraded,
  goalRev,
  endedReason,
  parseGoalMoves,
  cardsToApply,
  normalizeProblem,
  applyGoalMoves,
  enqueueGoalOwnerRun,
  chatAskAdmission,
  firstGoalReviewKey,
  firstGoalReviewRetryKey,
  goalOwnerDailyCap,
  GOAL_OWNER_DAILY_CAP,
  GOAL_OWNER_DAILY_CAP_AD_BUDGET,
  AD_BUDGET_REVIEW_NOTE_KEY,
  alertsSinceLastNote,
  NO_REPO_NOTE,
  CGO_TARGETS,
  reviewMetaFromPayload,
  shownCardsFromPayload,
  applyApprovedGoalChange,
  projectedAtDue,
  statusLineFor,
  windowsLookMismatched,
  goalPace,
  noteGoalViews,
  composeGoalOwnerContext,
  decisionActor,
  syncGoalWork,
  adIntentKey,
  producedLiveAd,
  ordersWithoutLiveAd,
  refusedMoveItems,
  planLegacyAdDecisions,
  allowedAgents,
  planLockedLine,
  pickPlanLineChannels,
  CGO_CARD_CLASS,
  type GoalMoves,
  type GoalRow,
} from "../goal-owner";
import { CHANNELS } from "@zavi/shared";
import { monthViewOf } from "../../../../workers/functions/__tests__/_ad-budget-fake";

const T = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const G1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const G2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const GX = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NOW = new Date("2026-09-26T12:00:00Z");

function goal(id: string, over: Partial<GoalRow> & { tenant_id?: string } = {}): Row {
  return {
    id,
    tenant_id: T,
    objective: "Get 20 signups",
    target_metric: "weekly_signups",
    target_value: 20,
    current_value: 6,
    due_date: "2026-10-31",
    status: "active",
    priority: 50,
    measurement_mode: "manual_reported",
    current_value_at: "2026-09-25T12:00:00Z",
    ...over,
  };
}

function emitter() {
  const emitted: Array<{ cls: string; body: Row }> = [];
  const emitDecision = vi.fn(async (cls: string, body: unknown) => {
    emitted.push({ cls, body: body as Row });
    db.decisions.push({
      id: `d-${emitted.length}`,
      tenant_id: T,
      agent_run_id: "run-1",
      decision_class: cls,
      status: "proposed",
      body,
    });
    return `d-${emitted.length}`;
  });
  return { emitted, emitDecision };
}

const noRepo = async () => null;
const review = (goals: GoalMoves["goals"], extra: Partial<GoalMoves> = {}): GoalMoves => ({ goals, goal_changes: [], channel_changes: [], ...extra });
const perItem = (...slugs: string[]) => ({
  paid: [],
  organic: slugs.map((channel_slug) => ({ channel_slug, clock: "days", evidence: "per_item" as const, label: "judge on these items' own numbers, on this channel's clock" })),
  own_moves: [],
});

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  db.autopilot_goals = [];
  db.decisions = [];
  db.agent_runs = [];
  db.tenant_channels = [];
  db.cgo_notes = [];
  db.cgo_questions = [];
  rpcCalls.length = 0;
  failReads.clear();
  rpcResult = {};
  enqueueAgentRun.mockReset();
  autopilotOn = true;
  tenantTier = "pro";
});

describe("budgetContextDegraded (the budget review's signature is kept only for a review that saw the money)", () => {
  const pace = { daily_target_usd: 5, actual_today_usd: 0, actual_month_usd: 0, required_so_far_usd: 50, delivery_debt_usd: 50, live_ads_per_day_usd: 5, days_left: 10, behind: true, data_fresh: true };
  it("is false without an ad budget, and with both the pace and the live forecast read", () => {
    expect(budgetContextDegraded({})).toBe(false);
    expect(budgetContextDegraded({ ad_budget: {} as never, spend_pace: pace })).toBe(false);
  });
  it("is true when the pace or the live forecast could not be read", () => {
    expect(budgetContextDegraded({ ad_budget: {} as never })).toBe(true);
    expect(budgetContextDegraded({ ad_budget: {} as never, spend_pace: { ...pace, live_ads_per_day_usd: null } })).toBe(true);
  });
});

describe("pure helpers", () => {
  it("the next review sees the direct alerts sent since its last note, newest first, and nothing older", () => {
    const note = (created_at: string, alarm_keys: string[], headline: string | null = null) => ({ created_at, alarm_keys, headline });
    expect(
      alertsSinceLastNote([
        note("2026-09-26T10:00:00Z", ["cgo_blockers", "urgent"], "Needs you now: Reconnect Meta Ads in Settings"),
        note("2026-09-26T09:00:00Z", ["cgo_blockers", "urgent"], "Needs you now: Check Meta Ads"),
        note("2026-09-26T08:00:00Z", [AD_BUDGET_REVIEW_NOTE_KEY], "Raised Brand"),
        note("2026-09-26T07:00:00Z", ["cgo_blockers", "urgent"], "Needs you now: older"),
      ]),
    ).toEqual([
      { at: "2026-09-26T10:00:00Z", what: "Needs you now: Reconnect Meta Ads in Settings" },
      { at: "2026-09-26T09:00:00Z", what: "Needs you now: Check Meta Ads" },
    ]);
    expect(alertsSinceLastNote([note("2026-09-26T08:00:00Z", [], "x")])).toEqual([]);
  });

  it("reuses a review note on retry without applying its moves again", async () => {
    const emitDecision = emitter().emitDecision;
    const moves = review([], { note: { need: [], questions: [{ topic: "approval", about: "ad_budget", ask: "Should I approve this bid cap?" }] } });
    const deps = { emitDecision, resolveRepo: noRepo, now: NOW };
    const first = await applyGoalMoves(T, "replayed-run", moves, deps);
    const second = await applyGoalMoves(T, "replayed-run", moves, deps);
    expect(second.note_id).toBe(first.note_id);
    expect(db.cgo_notes).toHaveLength(1);
    expect(db.cgo_questions).toHaveLength(1);
    db.cgo_notes[0].notified = true;
    expect((await applyGoalMoves(T, "replayed-run", moves, deps)).note_notify).toBe(false);
  });

  it("goalRev changes with the ask (objective, metric, target, due date), not with progress", () => {
    const base = { objective: "Get 20 signups", target_metric: "weekly_signups", target_value: 20, due_date: "2026-10-31" };
    expect(goalRev(base)).toBe(goalRev({ ...base }));
    expect(goalRev(base)).not.toBe(goalRev({ ...base, target_value: 30 }));
    expect(goalRev(base)).not.toBe(goalRev({ ...base, due_date: "2026-11-30" }));
    expect(goalRev(base)).not.toBe(goalRev({ ...base, target_metric: "stripe_mrr" }));
  });

  it("a lower-is-better goal (target below its baseline) is met by going down to it", () => {
    const cpa = goal(G1, { target_metric: "cost per acquisition", baseline_value: 20, target_value: 10, current_value: 8 }) as GoalRow;
    expect(endedReason(cpa, "2026-09-26")).toBe("met");
    expect(endedReason({ ...cpa, current_value: 12 }, "2026-09-26")).toBeNull();
  });

  it("endedReason: met on reaching the target, due_passed after the due date, else null", () => {
    expect(endedReason(goal(G1, { current_value: 20 }) as GoalRow, "2026-09-26")).toBe("met");
    expect(endedReason(goal(G1, { due_date: "2026-09-25" }) as GoalRow, "2026-09-26")).toBe("due_passed");
    expect(endedReason(goal(G1) as GoalRow, "2026-09-26")).toBeNull();
    expect(endedReason(goal(G1, { current_value: null }) as GoalRow, "2026-09-26")).toBeNull();
  });

  it("parseGoalMoves: reads the block, rejects a missing block and bad JSON", () => {
    const ok = parseGoalMoves(`x <goal_moves>{"goals":[{"goal_id":"${G1}","status_line":"6 of 20","moves":[]}]}</goal_moves>`);
    expect(ok.ok).toBe(true);
    expect(parseGoalMoves("no block").ok).toBe(false);
    expect(parseGoalMoves("<goal_moves>{nope</goal_moves>").ok).toBe(false);
    expect(parseGoalMoves(`<goal_moves>{"goals":[{"goal_id":"not-a-uuid","status_line":"x"}]}</goal_moves>`).ok).toBe(false);
  });
});

describe("windowsLookMismatched (GS10): no confident pace from numbers that cannot share a window", () => {
  const live = (over: Partial<GoalRow> = {}) => goal("g-live", {
    target_metric: "gmv", target_value: 300_000, baseline_value: 157_000,
    current_value: 3_446, created_at: "2026-10-01T18:55:50Z",
    current_value_at: "2026-10-01T18:58:17Z", ...over,
  }) as GoalRow;
  it("the live mismatched goal projects nothing and names the gap instead of 'about 0'", () => {
    expect(windowsLookMismatched(live())).toBe(true);
    expect(projectedAtDue(live(), "2026-10-06")).toBeNull();
    const line = statusLineFor(live(), "2026-10-06");
    expect(line).not.toContain("on pace for about 0");
    expect(line).toContain("this period's total or a running level");
  });
  it("the 10-11 reading (70,000 of 300,000 on a 157,000 baseline) projects nothing, and is still behind on both readings", () => {
    const g = live({ current_value: 70_000, current_value_at: "2026-10-11T03:20:53Z" });
    expect(projectedAtDue(g, "2026-10-12")).toBeNull();
    expect(statusLineFor(g, "2026-10-12")).not.toMatch(/on pace for/);
    expect(goalPace(g, "2026-10-12").behind_required).toBe(true);
    expect(noteGoalViews([g], "2026-10-12")[0]).toMatchObject({ progress: null, pace: null });
  });
  it("an ambiguous goal hands the model no daily rate either (the status line withholds the pace)", () => {
    const g = live({ current_value: 70_000, current_value_at: "2026-10-11T03:20:53Z" });
    expect(goalPace(g, "2026-10-12")).toMatchObject({ days_left: 20, remaining: null, required_per_day: null, behind_required: true });
  });
  it("once the founder says it is this month's total, it paces from 0 on Oct 1", () => {
    const g = live({ current_value: 70_000, current_value_at: "2026-10-11T03:20:53Z", value_kind: "period_total", value_period_start: "2026-10-01" });
    expect(windowsLookMismatched(g)).toBe(false);
    expect(projectedAtDue(g, "2026-10-12")).toBe(197_273);
    expect(statusLineFor(g, "2026-10-12")).toContain("on pace for about $197,273 by Oct 31");
    expect(noteGoalViews([g], "2026-10-12")[0].progress).toBeCloseTo(70_000 / 300_000);
  });
  it("a month-to-date number ABOVE the baseline is ambiguous too, and not behind while the period line says it is ahead", () => {
    const g = live({ current_value: 160_000, current_value_at: "2026-10-10T00:00:00Z" });
    expect(projectedAtDue(g, "2026-10-10")).toBeNull();
    expect(goalPace(g, "2026-10-10").behind_required).toBe(false);
  });
  it("a running number the founder confirmed keeps the baseline line", () => {
    const g = live({ current_value: 160_000, current_value_at: "2026-10-10T00:00:00Z", value_kind: "gauge" });
    expect(windowsLookMismatched(g)).toBe(false);
    expect(projectedAtDue(g, "2026-10-10")).toBe(166_300);
  });
  it("a measured number, or a confirmed count rule, is taken at its word", () => {
    expect(windowsLookMismatched(live({ measurement_mode: "auto" }))).toBe(false);
    expect(windowsLookMismatched(live({ count_rule: { dialect: "sql", source: "operator_db", query: "select count(*) from orders", definition: "gmv this month", schema_hash: "h1", confirmed_at: "2026-10-01T00:00:00Z" } }))).toBe(false);
  });
  it("compatible numbers, lower-is-better goals and no-baseline goals are untouched", () => {
    expect(windowsLookMismatched(live({ target_metric: "cost per booking", target_value: 100_000, baseline_value: 157_000, current_value: 3_446 }))).toBe(false);
    expect(windowsLookMismatched(live({ target_value: 100_000, baseline_value: 157_000, current_value: 3_446 }))).toBe(true);
    expect(windowsLookMismatched(live({ baseline_value: null }))).toBe(false);
  });
});

describe("applyGoalMoves", () => {
  it("autopilot on: cgo starts a research/pm/content-design card itself and says so; an engineer card waits", async () => {
    db.autopilot_goals.push(goal(G1));
    const { emitDecision } = emitter();
    const autoRun = vi.fn(async () => true);
    await applyGoalMoves(
      T,
      "run-1",
      review([
        {
          goal_id: G1,
          status_line: "6 of 20 signups",
          moves: [
            { target_agent_slug: "research", intent: "price the three rivals", why: "" },
            { target_agent_slug: "engineer", intent: "fix the signup form", why: "" },
          ],
        },
      ]),
      { emitDecision, resolveRepo: async () => ({ repo: "acme/site" }), now: NOW, autoRun, meta: { kind: "scheduled", alarm_keys: [], autopilot: true } },
    );
    expect(autoRun.mock.calls).toEqual([[T, "d-1"]]);
    expect(db.cgo_notes[0].changed).toEqual(["Started research: price the three rivals"]);
  });

  it("a research move asking for the tenant's own records is taken out before planning, shown as blocked, and never crowds out a valid one (BUG3)", async () => {
    db.autopilot_goals.push(goal(G1));
    const { emitted, emitDecision } = emitter();
    const autoRun = vi.fn(async () => true);
    const catalog = vi.fn(async () => ({ dialect: "mongo", catalog: { tables: [{ name: "trips", columns: [], rowEstimate: null }] }, discovery_error: null }));
    await applyGoalMoves(
      T,
      "run-1",
      review([
        {
          goal_id: G1,
          status_line: "x",
          moves: [
            { target_agent_slug: "research", intent: "Read only. From the trips data, count host cancellations since Oct 1", why: "" },
            { target_agent_slug: "research", intent: "price the three rivals", why: "" },
          ],
        },
      ]),
      {
        emitDecision,
        resolveRepo: noRepo,
        now: NOW,
        autoRun,
        meta: { kind: "scheduled", alarm_keys: [], autopilot: true },
        countDeps: { catalog } as unknown as NonNullable<Parameters<typeof applyGoalMoves>[3]["countDeps"]>,
      },
    );
    expect(emitted.map((e) => (e.body as { intent?: string }).intent)).toEqual(["price the three rivals"]);
    expect(db.cgo_notes[0].refused).toContainEqual(expect.stringContaining('research reads the public web, not your own records (it asked for your "trips" data)'));
    expect(db.cgo_notes[0].items).toContainEqual(expect.objectContaining({ section: "blocked", text: 'Did not start Research work for "Get 20 signups"', reason: 'Research reads the public web, not your own records (it asked for your "trips" data)' }));
    expect(catalog).toHaveBeenCalledTimes(1);
  });

  describe("a hypothesis only the founder's own records can settle (owner call C)", () => {
    it("verify_with_founder parses; a bad value is dropped, never the review", () => {
      const ok = parseGoalMoves(`<goal_moves>${JSON.stringify({ goals: [], verify_with_founder: { goal_id: G1, hypothesis: "h1", why: "Only your bookings show it." } })}</goal_moves>`);
      expect(ok.ok && ok.value.verify_with_founder).toEqual({ goal_id: G1, hypothesis: "h1", why: "Only your bookings show it." });
      const bad = parseGoalMoves(`<goal_moves>${JSON.stringify({ goals: [], verify_with_founder: { goal_id: "nope", hypothesis: "" } })}</goal_moves>`);
      expect(bad.ok).toBe(true);
      expect(bad.ok && bad.value.verify_with_founder).toBeUndefined();
    });

    const hypRows = async (status: "testing" | "listed" | "ruled_out" = "testing") => {
      const { makeGate, makeResolver } = await vi.importActual<typeof import("../cgo-hypotheses")>("../cgo-hypotheses");
      const base = { tenant_id: T, goal_id: G1, refute_if: null, rank: 1, evidence: [], evidence_version: 0, expected_gain: null, research_open: false, research_card_id: null, created_at: "", status_at: "" };
      const rows = [
        { ...base, id: "h-cancel", problem: "retention" as const, claim: "Most hosts cancel bookings renters already paid for", status },
        { ...base, id: "h-other", problem: "traffic" as const, claim: "Too few people find the site", status: "testing" as const },
      ];
      return { rows, prepareHypotheses: (async () => ({ rows, gate: makeGate(rows, new Map()), resolve: makeResolver(rows, new Map()), refused: [], dropped: 0 })) as never };
    };
    const catalog = vi.fn(async () => ({ dialect: "mongo", catalog: { tables: [{ name: "trips", columns: [], rowEstimate: null }] }, discovery_error: null }));
    const hypQuestions = () => db.cgo_questions.filter((q) => String(q.topic_key).startsWith("hyp:"));

    it("research on it was refused: the founder is asked, once, with the whole claim", async () => {
      db.autopilot_goals.push(goal(G1));
      const { prepareHypotheses } = await hypRows();
      await applyGoalMoves(
        T,
        "run-1",
        review([{ goal_id: G1, status_line: "x", moves: [{ target_agent_slug: "research", intent: "From the trips data, count host cancellations", why: "", hypothesis: "h-cancel" }] }], {
          verify_with_founder: { goal_id: G1, hypothesis: "h-other", why: "w" },
        } as Partial<GoalMoves>),
        { emitDecision: emitter().emitDecision, resolveRepo: noRepo, now: NOW, autoRun: vi.fn(async () => true), prepareHypotheses, countDeps: { catalog } as never },
      );
      expect(hypQuestions()).toHaveLength(1);
      expect(hypQuestions()[0]).toMatchObject({
        topic_key: "hyp:h-cancel",
        ask: "Is this true for your business: Most hosts cancel bookings renters already paid for?",
        on_yes: { kind: "hypothesis_check", hypothesis_id: "h-cancel", goal_id: G1, claim: "Most hosts cancel bookings renters already paid for" },
      });
    });

    it("cgo names one to verify; a closed one, or one on another goal, is never asked", async () => {
      db.autopilot_goals.push(goal(G1));
      const { prepareHypotheses } = await hypRows();
      const run = (v: Record<string, unknown>, prep = prepareHypotheses) =>
        applyGoalMoves(T, `run-${Math.random()}`, review([{ goal_id: G1, status_line: "x", moves: [] }], { verify_with_founder: v } as Partial<GoalMoves>), {
          emitDecision: emitter().emitDecision, resolveRepo: noRepo, now: NOW, autoRun: vi.fn(async () => true), prepareHypotheses: prep,
        });
      await run({ goal_id: G2, hypothesis: "h-cancel", why: "w" });
      expect(hypQuestions()).toHaveLength(0);
      const closed = await hypRows("ruled_out");
      await run({ goal_id: G1, hypothesis: "h-cancel", why: "w" }, closed.prepareHypotheses);
      expect(hypQuestions()).toHaveLength(0);
      await run({ goal_id: G1, hypothesis: "h-cancel", why: "Only your bookings show this." });
      expect(hypQuestions().map((q) => [q.topic_key, q.why])).toEqual([["hyp:h-cancel", "Only your own records can settle this, so only you can tell me."]]);
    });

    it("the founder's emailed words, as stored, become its evidence; the model's paraphrase never does", async () => {
      db.autopilot_goals.push(goal(G1));
      const QH = "44444444-4444-4444-8444-444444444444";
      db.cgo_questions.push({ id: QH, tenant_id: T, status: "open", topic_key: "hyp:h-cancel", ask: "Is this true?", on_yes: { kind: "hypothesis_check", hypothesis_id: "h-cancel", goal_id: G1, claim: "c" } });
      rpcResult.answer_hypothesis_question = { outcome: "applied", status: "testing", line: null };
      await applyGoalMoves(T, "run-r", review([{ goal_id: G1, status_line: "x", moves: [] }], { answered: [{ question_id: QH, answer: "they agreed" }] } as Partial<GoalMoves>), {
        emitDecision: emitter().emitDecision, resolveRepo: noRepo, now: NOW,
        meta: { kind: "founder", alarm_keys: [], autopilot: true, reply_via: "email", reply_text: "Only on weekends, maybe a third of them." },
      });
      const call = rpcCalls.find((c) => c.fn === "answer_hypothesis_question");
      expect(call?.args).toMatchObject({ p_tenant_id: T, p_question_id: QH, p_kind: "words", p_words: "Only on weekends, maybe a third of them.", p_via: "email" });
      expect(db.cgo_questions[0].answer).toBeUndefined();
    });

    it("a web wake (text the server wrote about a tap) is never stored as the founder's words", async () => {
      db.autopilot_goals.push(goal(G1));
      const QH = "55555555-5555-4555-8555-555555555555";
      db.cgo_questions.push({ id: QH, tenant_id: T, status: "open", topic_key: "hyp:h-cancel", ask: "Is this true?", on_yes: { kind: "hypothesis_check", hypothesis_id: "h-cancel", goal_id: G1, claim: "c" } });
      await applyGoalMoves(T, "run-w", review([{ goal_id: G1, status_line: "x", moves: [] }], { answered: [{ question_id: QH, answer: "yes" }] } as Partial<GoalMoves>), {
        emitDecision: emitter().emitDecision, resolveRepo: noRepo, now: NOW,
        meta: { kind: "founder", alarm_keys: [], autopilot: true, reply_via: "web", reply_text: 'Your question "x" was answered: Yes.' },
      });
      expect(rpcCalls.some((c) => c.fn === "answer_hypothesis_question")).toBe(false);
    });

    it("the founder's words could not be recorded: the note says so, the review still applies", async () => {
      db.autopilot_goals.push(goal(G1));
      const QH = "66666666-6666-4666-8666-666666666666";
      db.cgo_questions.push({ id: QH, tenant_id: T, status: "open", topic_key: "hyp:h-cancel", ask: "Is this true?", on_yes: { kind: "hypothesis_check", hypothesis_id: "h-cancel", goal_id: G1, claim: "c" } });
      rpcResult.answer_hypothesis_question = new Error("connection reset");
      const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
      await applyGoalMoves(T, "run-e", review([{ goal_id: G1, status_line: "x", moves: [] }], { answered: [{ question_id: QH, answer: "x" }] } as Partial<GoalMoves>), {
        emitDecision: emitter().emitDecision, resolveRepo: noRepo, now: NOW,
        meta: { kind: "founder", alarm_keys: [], autopilot: true, reply_via: "slack", reply_text: "Mostly true." },
      });
      err.mockRestore();
      expect(db.cgo_questions[0].status).toBe("open");
      expect(db.cgo_notes.at(-1)?.items).toContainEqual(expect.objectContaining({ section: "needs_you", text: "Answer my question about your own records again" }));
    });

    it("a founder's no stops the work even with the gate in shadow; a checker's ruling stays shadow-only", async () => {
      db.autopilot_goals.push(goal(G1));
      const { makeGate, makeResolver } = await vi.importActual<typeof import("../cgo-hypotheses")>("../cgo-hypotheses");
      const base = { tenant_id: T, goal_id: G1, problem: "retention" as const, refute_if: null, rank: 1, evidence_version: 0, expected_gain: null, research_open: false, research_card_id: null, created_at: "", status_at: "" };
      const rows = [{ ...base, id: "h-c", claim: "c", status: "testing" as const, evidence: [] }];
      const run = async (live: Record<string, unknown>) => {
        const prepareHypotheses = (async () => ({ rows, gate: makeGate(rows, new Map()), resolve: makeResolver(rows, new Map()), refused: [], dropped: 0, readNow: async () => ({ ...rows[0], ...live }) })) as never;
        const { emitted, emitDecision } = emitter();
        await applyGoalMoves(T, `run-${Math.random()}`, review([{ goal_id: G1, status_line: "x", moves: [{ target_agent_slug: "seo", intent: "fix the sitemap", why: "", hypothesis: "h-c" }] }]), {
          emitDecision, resolveRepo: noRepo, now: NOW, autoRun: vi.fn(async () => true), prepareHypotheses, gateEnforced: false,
        });
        return emitted;
      };
      const founderNo = { status: "ruled_out", evidence: [{ at: "t", kind: "founder", ref: "q", excerpt: "x", verdict: "ruled_out" }] };
      expect(await run(founderNo)).toHaveLength(0);
      const checkerNo = { status: "ruled_out", evidence: [{ at: "t", kind: "run", ref: "r", excerpt: "x", verdict: "ruled_out" }] };
      expect((await run(checkerNo)).map((e) => e.body.gate_would_refuse)).toEqual(["ruled_out"]);
    });

    it("the founder said no while the review ran: the work it would have started is refused (enforce)", async () => {
      db.autopilot_goals.push(goal(G1));
      const { makeGate, makeResolver } = await vi.importActual<typeof import("../cgo-hypotheses")>("../cgo-hypotheses");
      const base = { tenant_id: T, goal_id: G1, problem: "retention" as const, refute_if: null, rank: 1, evidence: [], evidence_version: 0, expected_gain: null, research_open: false, research_card_id: null, created_at: "", status_at: "" };
      const rows = [{ ...base, id: "h-c", claim: "c", status: "confirmed" as const }];
      const prepareHypotheses = (async () => ({
        rows, gate: makeGate(rows, new Map()), resolve: makeResolver(rows, new Map()), refused: [], dropped: 0,
        readNow: async () => ({ ...rows[0], status: "ruled_out" as const }),
      })) as never;
      const { emitted, emitDecision } = emitter();
      await applyGoalMoves(T, "run-f", review([{ goal_id: G1, status_line: "x", moves: [{ target_agent_slug: "content-design", intent: "rewrite the cancel policy page", why: "", hypothesis: "h-c" }] }]), {
        emitDecision, resolveRepo: noRepo, now: NOW, autoRun: vi.fn(async () => true), prepareHypotheses, gateEnforced: true,
      });
      expect(emitted).toHaveLength(0);
      expect(db.cgo_notes.at(-1)?.refused).toContainEqual(expect.stringContaining('its hypothesis ("c") was ruled out'));
    });
  });

  it("a review whose only move was such a study says why in its headline, never 'a platform refused'", async () => {
    db.autopilot_goals.push(goal(G1));
    const { emitDecision } = emitter();
    const catalog = vi.fn(async () => ({ dialect: "mongo", catalog: { tables: [{ name: "trips", columns: [], rowEstimate: null }] }, discovery_error: null }));
    await applyGoalMoves(
      T,
      "run-1",
      review([{ goal_id: G1, status_line: "x", moves: [{ target_agent_slug: "research", intent: "From the trips data, count host cancellations", why: "" }] }], {
        note: { headline: "Researching cancellation patterns in your trips data" } as GoalMoves["note"],
      }),
      {
        emitDecision,
        resolveRepo: noRepo,
        now: NOW,
        autoRun: vi.fn(async () => true),
        meta: { kind: "scheduled", alarm_keys: [], autopilot: true },
        countDeps: { catalog } as unknown as NonNullable<Parameters<typeof applyGoalMoves>[3]["countDeps"]>,
      },
    );
    const headline = String(db.cgo_notes[0].headline);
    expect(headline).toContain("research reads the public web, not your own records");
    expect(headline).not.toMatch(/platform refused/);
  });

  it("a catalog whose discovery is now failing still names its last-known tables (research cannot read the database either way)", async () => {
    db.autopilot_goals.push(goal(G1));
    const { emitted, emitDecision } = emitter();
    const catalog = vi.fn(async () => ({ dialect: "mongo", catalog: { tables: [{ name: "trips", columns: [], rowEstimate: null }] }, discovery_error: "no_secret" }));
    await applyGoalMoves(
      T,
      "run-1",
      review([{ goal_id: G1, status_line: "x", moves: [{ target_agent_slug: "research", intent: "From the trips data, count host cancellations", why: "" }] }]),
      {
        emitDecision,
        resolveRepo: noRepo,
        now: NOW,
        autoRun: vi.fn(async () => true),
        meta: { kind: "scheduled", alarm_keys: [], autopilot: true },
        countDeps: { catalog } as unknown as NonNullable<Parameters<typeof applyGoalMoves>[3]["countDeps"]>,
      },
    );
    expect(emitted).toHaveLength(0);
    expect(db.cgo_notes[0].refused).toContainEqual(expect.stringContaining('it asked for your "trips" data'));
  });

  it("a pm card is never auto-started (an a2a pm run can enqueue engineer PRs)", async () => {
    db.autopilot_goals.push(goal(G1));
    const { emitDecision } = emitter();
    const autoRun = vi.fn(async () => true);
    await applyGoalMoves(
      T,
      "run-1",
      review([{ goal_id: G1, status_line: "x", moves: [{ target_agent_slug: "pm", intent: "map the trial steps", why: "" }] }]),
      { emitDecision, resolveRepo: noRepo, now: NOW, autoRun, meta: { kind: "scheduled", alarm_keys: [], autopilot: true } },
    );
    expect(autoRun).not.toHaveBeenCalled();
    expect(db.decisions[0].status).toBe("proposed");
  });

  it("a retried apply does not emit a second card for work this run already started", async () => {
    db.autopilot_goals.push(goal(G1));
    const { emitted, emitDecision } = emitter();
    const autoRun = vi.fn(async (_t: string, id: string) => {
      const d = db.decisions.find((x) => x.id === id);
      if (d) d.status = "approved";
      return true;
    });
    const moves = review([{ goal_id: G1, status_line: "x", moves: [{ target_agent_slug: "research", intent: "price the rivals", why: "" }] }]);
    const deps = { emitDecision, resolveRepo: noRepo, now: NOW, autoRun, meta: { kind: "scheduled" as const, alarm_keys: [], autopilot: true } };
    await applyGoalMoves(T, "run-1", moves, deps);
    db.decisions[0].status = "acted";
    await applyGoalMoves(T, "run-1", moves, deps);
    expect(emitted).toHaveLength(1);
    expect(autoRun).toHaveBeenCalledTimes(1);
  });

  it("an auto-start that fails leaves the card for the founder and adds no note line", async () => {
    db.autopilot_goals.push(goal(G1));
    const { emitDecision } = emitter();
    await applyGoalMoves(
      T,
      "run-1",
      review([{ goal_id: G1, status_line: "x", moves: [{ target_agent_slug: "content-design", intent: "rewrite the pricing page headline", why: "" }] }]),
      { emitDecision, resolveRepo: noRepo, now: NOW, autoRun: async () => false, meta: { kind: "scheduled", alarm_keys: [], autopilot: true } },
    );
    expect(db.decisions[0].status).toBe("proposed");
    expect(db.cgo_notes[0].changed).toEqual([]);
  });

  it("ignores a goal id that is not this tenant's active goal", async () => {
    db.autopilot_goals.push(goal(G1), goal(GX, { tenant_id: OTHER }));
    const { emitted, emitDecision } = emitter();
    await applyGoalMoves(
      T,
      "run-1",
      review([{ goal_id: GX, status_line: "theirs", moves: [{ target_agent_slug: "pm", intent: "x", why: "" }] }]),
      { emitDecision, resolveRepo: noRepo, now: NOW },
    );
    expect(emitted).toHaveLength(0);
    expect(db.autopilot_goals.find((g) => g.id === GX)?.cgo_status_line).toBeUndefined();
  });

  it("emits a card with the server's goal id, revision and cgo provenance, and writes the status line", async () => {
    db.autopilot_goals.push(goal(G1));
    const { emitted, emitDecision } = emitter();
    const res = await applyGoalMoves(
      T,
      "run-1",
      review([{ goal_id: G1, status_line: "6 of 20 signups", moves: [{ target_agent_slug: "research", intent: "price the three rivals", why: "buyers compare on price" }] }]),
      { emitDecision, resolveRepo: noRepo, now: NOW },
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0].cls).toBe("cgo.dispatch-specialist");
    expect(emitted[0].body).toMatchObject({
      target_agent_slug: "research",
      dispatched_by: "cgo",
      goal_id: G1,
      goal_rev: goalRev(goal(G1) as GoalRow),
      context_summary: "buyers compare on price",
    });
    expect(db.autopilot_goals[0].cgo_status_line).toBe("6 of 20 weekly signups, 35 days left");
    expect(res.cards_emitted).toBe(1);
  });

  it("hypothesis tracker: a move naming no hypothesis starts nothing; a copy move needs a confirmed one; engineer needs the checker to agree on its gain", async () => {
    db.autopilot_goals.push(goal(G1));
    const { makeGate } = await vi.importActual<typeof import("../cgo-hypotheses")>("../cgo-hypotheses");
    const base = { tenant_id: T, goal_id: G1, problem: "conversion" as const, refute_if: null, rank: 1, evidence: [], evidence_version: 0, expected_gain: null, research_open: false, research_card_id: null, created_at: "", status_at: "" };
    const rows = [
      { ...base, id: "h-confirmed", claim: "The booking form asks for an insurance ID", status: "confirmed" as const },
      { ...base, id: "h-testing", claim: "Too few people find the clinic", problem: "traffic" as const, status: "testing" as const },
    ];
    const prepareHypotheses = async () => ({ rows, gate: makeGate(rows, new Map()), refused: [], dropped: 0 });
    const run = async (moves: Array<Record<string, unknown>>, checker = async () => null as string | null) => {
      const { emitted, emitDecision } = emitter();
      await applyGoalMoves(T, `run-${Math.random()}`, review([{ goal_id: G1, moves: moves as never }]), {
        emitDecision,
        resolveRepo: async () => ({ repo: "acme/site" }),
        now: NOW,
        autoRun: async () => false,
        prepareHypotheses: prepareHypotheses as never,
        checker,
        gateEnforced: true,
      });
      return { emitted, refused: (db.cgo_notes.at(-1)?.refused as string[]) ?? [] };
    };

    const none = await run([{ target_agent_slug: "content-design", intent: "rewrite the booking page", why: "" }]);
    expect(none.emitted).toHaveLength(0);
    expect(none.refused.some((l) => l.includes("names no hypothesis"))).toBe(true);

    const early = await run([{ target_agent_slug: "content-design", intent: "rewrite the hero", why: "", hypothesis: "h-testing" }]);
    expect(early.emitted).toHaveLength(0);

    const copy = await run([{ target_agent_slug: "content-design", intent: "make insurance optional on the form copy", why: "", hypothesis: "h-confirmed" }]);
    expect(copy.emitted.map((e) => e.body.hypothesis_id)).toEqual(["h-confirmed"]);

    const eng = { target_agent_slug: "engineer", intent: "make the insurance field optional", why: "", hypothesis: "h-confirmed", expected_gain: 10 };
    expect((await run([eng])).emitted).toHaveLength(0);
    const agrees = async () => JSON.stringify({ verdicts: [{ id: "h-confirmed", verdict: "testing", quote: "", why: "", gain_plausible: true }] });
    expect((await run([eng], agrees)).emitted.map((e) => e.body.target_agent_slug)).toEqual(["engineer"]);
  });

  describe("Top 10 #7: moves as tests", () => {
    const setup = async (opts: { trackerStores: boolean; moves: Array<Record<string, unknown>> }) => {
      db.autopilot_goals.push(goal(G1));
      const { makeGate } = await vi.importActual<typeof import("../cgo-hypotheses")>("../cgo-hypotheses");
      const base = { tenant_id: T, goal_id: G1, problem: "traffic" as const, refute_if: null, rank: 1, evidence_version: 0, expected_gain: null, research_open: false, research_card_id: null, created_at: "", status_at: "" };
      const FINDING = "Test readout (x): WORKED. 11 visits a day";
      let seenFindings: unknown[] = [];
      const prepareHypotheses = async (a: { findings?: unknown[] }) => {
        seenFindings = a.findings ?? [];
        const evidence = opts.trackerStores ? [{ at: "", kind: "cgo_read" as const, ref: "run-tests", excerpt: FINDING }] : [];
        const rows = [{ ...base, id: "h-testing", claim: "Too few people find the clinic", status: "testing" as const, evidence }];
        return { rows, gate: makeGate(rows, new Map()), refused: [], dropped: 0 };
      };
      const markFindingsDelivered = vi.fn(async () => undefined);
      const { emitted, emitDecision } = emitter();
      const proposed = review([{ goal_id: G1, moves: opts.moves as never }]);
      (proposed as unknown as Record<string, unknown>).readouts = [{ decision_id: "33333333-3333-4333-8333-333333333333", verdict: "worked", result: "11 visits a day" }];
      await applyGoalMoves(T, "run-tests", proposed, {
        emitDecision,
        resolveRepo: async () => ({ repo: "acme/site" }),
        now: NOW,
        autoRun: async () => false,
        prepareHypotheses: prepareHypotheses as never,
        readDueTests: async () => ({ due: [], more: 0 }),
        applyReadouts: (async () => ({ saved: 1, findings: [{ decision_id: "dec-due", hypothesis: "h-testing", finding: FINDING }] })) as never,
        readUndeliveredFindings: async () => [{ decision_id: "dec-old", hypothesis: "h-testing", finding: "an older undelivered readout" }],
        markFindingsDelivered: markFindingsDelivered as never,
        gateEnforced: true,
      });
      return { emitted, seenFindings, markFindingsDelivered, FINDING };
    };
    const test = { variable: "the opening line", budget_usd: 20, baseline: "3 visits a day", success_if: "10 visits a day", stop_if: "under 3 after a week", readout_on: "2099-01-01" };

    it("a move's test lands on its card with the readout held to 30 days", async () => {
      const { emitted } = await setup({ trackerStores: true, moves: [{ target_agent_slug: "research", intent: "test a new opening line", why: "", hypothesis: "h-testing", test }] });
      const card = emitted.find((e) => e.body.target_agent_slug === "research");
      expect(card?.body.test).toMatchObject({ variable: "the opening line", success_if: "10 visits a day" });
      expect(String((card?.body.test as Record<string, unknown>).readout_on) < "2099-01-01").toBe(true);
    });
    it("fresh AND earlier-undelivered readout findings reach the tracker; marked delivered only when its evidence holds them", async () => {
      const ok = await setup({ trackerStores: true, moves: [] });
      expect(ok.seenFindings).toEqual(expect.arrayContaining([{ hypothesis: "h-testing", finding: ok.FINDING }, { hypothesis: "h-testing", finding: "an older undelivered readout" }]));
      expect(ok.markFindingsDelivered).toHaveBeenCalledWith(T, expect.any(String), ["dec-due"]);
    });
  });

  it("Top 10 #7 (review): a readout the tracker did NOT store is not marked delivered, so it is re-sent", async () => {
    db.autopilot_goals.push(goal(G1));
    const { makeGate } = await vi.importActual<typeof import("../cgo-hypotheses")>("../cgo-hypotheses");
    const rows = [{ tenant_id: T, goal_id: G1, problem: "traffic" as const, refute_if: null, rank: 1, evidence: [], evidence_version: 0, expected_gain: null, research_open: false, research_card_id: null, created_at: "", status_at: "", id: "h-testing", claim: "c", status: "testing" as const }];
    const markFindingsDelivered = vi.fn(async () => undefined);
    const { emitDecision } = emitter();
    const proposed = review([{ goal_id: G1, moves: [] }]);
    (proposed as unknown as Record<string, unknown>).readouts = [{ decision_id: "33333333-3333-4333-8333-333333333333", verdict: "worked", result: "11" }];
    await applyGoalMoves(T, "run-x", proposed, {
      emitDecision, resolveRepo: async () => null, now: NOW, autoRun: async () => false,
      prepareHypotheses: (async () => ({ rows, gate: makeGate(rows, new Map()), refused: [], dropped: 0 })) as never,
      readDueTests: async () => ({ due: [], more: 0 }),
      applyReadouts: (async () => ({ saved: 1, findings: [{ decision_id: "dec-due", hypothesis: "h-testing", finding: "Test readout: WORKED. 11" }] })) as never,
      readUndeliveredFindings: async () => [],
      markFindingsDelivered: markFindingsDelivered as never,
      gateEnforced: true,
    });
    expect(markFindingsDelivered).toHaveBeenCalledWith(T, expect.any(String), []);
  });

  it("Top 10 #7: test coverage is recorded on every card — a test, an exemption reason, or test_missing", async () => {
    db.autopilot_goals.push(goal(G1));
    const { makeGate } = await vi.importActual<typeof import("../cgo-hypotheses")>("../cgo-hypotheses");
    const rows = [{ tenant_id: T, goal_id: G1, problem: "traffic" as const, refute_if: null, rank: 1, evidence: [], evidence_version: 0, expected_gain: null, research_open: false, research_card_id: null, created_at: "", status_at: "", id: "h-testing", claim: "c", status: "testing" as const }];
    const { emitted, emitDecision } = emitter();
    await applyGoalMoves(T, "run-c", review([{ goal_id: G1, moves: [
      { target_agent_slug: "research", intent: "find why visitors leave", why: "", hypothesis: "h-testing", no_test_because: "a diagnosis, nothing changes yet" },
      { target_agent_slug: "seo", intent: "fix the broken sitemap", why: "", hypothesis: "h-testing" },
    ] as never }]), {
      emitDecision, resolveRepo: async () => null, now: NOW, autoRun: async () => false,
      prepareHypotheses: (async () => ({ rows, gate: makeGate(rows, new Map()), refused: [], dropped: 0 })) as never,
      gateEnforced: true,
    });
    const by = (slug: string) => emitted.find((e) => e.body.target_agent_slug === slug)?.body;
    expect(by("research")).toMatchObject({ test_exempt: "a diagnosis, nothing changes yet" });
    expect(by("seo")).toMatchObject({ test_missing: true });
  });

  it("hypothesis tracker, shadow mode (default): the gate blocks nothing, only records what it would refuse", async () => {
    db.autopilot_goals.push(goal(G1));
    const { makeGate } = await vi.importActual<typeof import("../cgo-hypotheses")>("../cgo-hypotheses");
    const prepareHypotheses = async () => ({ rows: [], gate: makeGate([], new Map()), refused: [], dropped: 0 });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { emitted, emitDecision } = emitter();
    await applyGoalMoves(T, "run-shadow", review([{ goal_id: G1, moves: [{ target_agent_slug: "content-design", intent: "rewrite the booking page", why: "" }] }]), {
      emitDecision,
      resolveRepo: noRepo,
      now: NOW,
      autoRun: async () => false,
      prepareHypotheses: prepareHypotheses as never,
      gateEnforced: false,
    });
    expect(emitted.map((e) => e.body.target_agent_slug)).toEqual(["content-design"]);
    expect(emitted[0].body.gate_would_refuse).toBe("no_hypothesis");
    expect(logEvents.some((e) => e.source === "cgo.gate" && e.code === "would_refuse" && (e.meta as Record<string, unknown>)?.gate_reason === "no_hypothesis" && (e.meta as Record<string, unknown>)?.target_agent_slug === "content-design")).toBe(true);
    expect(JSON.stringify(logEvents)).not.toContain("rewrite the booking page");
    expect(info.mock.calls.some(([l]) => String(l).includes("[cgo-gate-shadow]") && String(l).includes("names no hypothesis"))).toBe(true);
    expect(((db.cgo_notes.at(-1)?.refused as string[]) ?? []).some((l) => l.includes("names no hypothesis"))).toBe(false);
    info.mockRestore();
  });

  it("never targets operator, cgo or chief-of-staff, or an agent the tenant cannot see", async () => {
    db.autopilot_goals.push(goal(G1));
    const { emitted, emitDecision } = emitter();
    await applyGoalMoves(
      T,
      "run-1",
      review([
        {
          goal_id: G1,
          status_line: "x",
          moves: ["operator", "cgo", "chief-of-staff", "tiktok_ads"].map((t) => ({ target_agent_slug: t, intent: "x", why: "" })),
        },
      ]),
      { emitDecision, resolveRepo: noRepo, now: NOW },
    );
    expect(emitted).toHaveLength(0);
  });

  it("caps at 2 moves per goal and 6 new cards per review", async () => {
    const ids = [G1, G2, "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1", "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1"];
    for (const id of ids) db.autopilot_goals.push(goal(id));
    const { emitted, emitDecision } = emitter();
    const agents = ["research", "pm", "content-design"];
    await applyGoalMoves(
      T,
      "run-1",
      review(ids.map((id) => ({ goal_id: id, status_line: "x", moves: agents.map((a) => ({ target_agent_slug: a, intent: "x", why: "" })) }))),
      { emitDecision, resolveRepo: noRepo, now: NOW },
    );
    expect(emitted).toHaveLength(6);
    for (const id of ids) expect(emitted.filter((e) => e.body.goal_id === id).length).toBeLessThanOrEqual(2);
  });

  it("does not re-propose an agent that already has an open card on the goal", async () => {
    db.autopilot_goals.push(goal(G1));
    db.decisions.push({
      id: "open-1",
      tenant_id: T,
      decision_class: "cgo.dispatch-specialist",
      status: "proposed",
      body: { goal_id: G1, goal_rev: goalRev(goal(G1) as GoalRow), target_agent_slug: "pm" },
    });
    const { emitted, emitDecision } = emitter();
    await applyGoalMoves(T, "run-1", review([{ goal_id: G1, status_line: "x", moves: [{ target_agent_slug: "pm", intent: "again", why: "" }] }]), {
      emitDecision,
      resolveRepo: noRepo,
      now: NOW,
    });
    expect(emitted).toHaveLength(0);
  });

  it("expires an open card from an older goal revision, then may propose that agent again", async () => {
    db.autopilot_goals.push(goal(G1, { target_value: 30 }));
    db.decisions.push({
      id: "old-rev",
      tenant_id: T,
      decision_class: "cgo.dispatch-specialist",
      status: "proposed",
      body: { goal_id: G1, goal_rev: goalRev(goal(G1) as GoalRow), target_agent_slug: "pm" },
    });
    const { emitted, emitDecision } = emitter();
    await applyGoalMoves(T, "run-1", review([{ goal_id: G1, status_line: "x", moves: [{ target_agent_slug: "pm", intent: "x", why: "" }] }]), {
      emitDecision,
      resolveRepo: noRepo,
      now: NOW,
    });
    expect(db.decisions.find((d) => d.id === "old-rev")?.status).toBe("expired");
    expect(emitted).toHaveLength(1);
  });

  it("skips a goal edited while the review ran: no card, no status line", async () => {
    db.autopilot_goals.push(goal(G1, { target_value: 30 }));
    const { emitted, emitDecision } = emitter();
    await applyGoalMoves(
      T,
      "run-1",
      review([{ goal_id: G1, status_line: "old ask", moves: [{ target_agent_slug: "pm", intent: "x", why: "" }] }]),
      { emitDecision, resolveRepo: noRepo, now: NOW, reviewedRevs: new Map([[G1, goalRev(goal(G1) as GoalRow)]]) },
    );
    expect(emitted).toHaveLength(0);
    expect(db.autopilot_goals[0].cgo_status_line).toBeUndefined();
  });

  it("expires open cards whose goal is no longer active (paused, missed, deleted)", async () => {
    db.autopilot_goals.push(goal(G1), goal(G2, { status: "paused" }));
    db.decisions.push(
      { id: "paused-card", tenant_id: T, decision_class: "cgo.dispatch-specialist", status: "proposed", body: { goal_id: G2, target_agent_slug: "seo" } },
      { id: "deleted-card", tenant_id: T, decision_class: "cgo.dispatch-specialist", status: "proposed", body: { goal_id: GX, target_agent_slug: "seo" } },
    );
    const { emitDecision } = emitter();
    await applyGoalMoves(T, "run-1", review([]), { emitDecision, resolveRepo: noRepo, now: NOW });
    expect(db.decisions.find((d) => d.id === "paused-card")?.status).toBe("expired");
    expect(db.decisions.find((d) => d.id === "deleted-card")?.status).toBe("expired");
  });

  it("engineer: no repo means no card and a note under the goal; a repo is the server's, never the model's", async () => {
    db.autopilot_goals.push(goal(G1));
    const a = emitter();
    await applyGoalMoves(T, "run-1", review([{ goal_id: G1, status_line: "6 of 20", moves: [{ target_agent_slug: "engineer", intent: "fix hero", why: "" }] }]), {
      emitDecision: a.emitDecision,
      resolveRepo: noRepo,
      now: NOW,
    });
    expect(a.emitted).toHaveLength(0);
    expect(db.autopilot_goals[0].cgo_status_line).toBe(`6 of 20 weekly signups, 35 days left ${NO_REPO_NOTE}`);

    const b = emitter();
    await applyGoalMoves(T, "run-2", review([{ goal_id: G1, status_line: "6 of 20", moves: [{ target_agent_slug: "engineer", intent: "fix hero", why: "" }] }]), {
      emitDecision: b.emitDecision,
      resolveRepo: async () => ({ repo: "acme/site" }),
      now: NOW,
    });
    expect(b.emitted[0].body.repo_hint).toBe("acme/site");
  });

  it("a met goal: records met on this tenant's still-active row, withdraws its open cards without suppressing, makes no new card", async () => {
    db.autopilot_goals.push(goal(G1, { current_value: 25 }));
    db.decisions.push({ id: "o1", tenant_id: T, decision_class: "cgo.dispatch-specialist", status: "proposed", body: { goal_id: G1 } });
    const { emitted, emitDecision } = emitter();
    const res = await applyGoalMoves(
      T,
      "run-1",
      review([{ goal_id: G1, status_line: "done", moves: [{ target_agent_slug: "pm", intent: "x", why: "" }] }]),
      { emitDecision, resolveRepo: noRepo, now: NOW },
    );
    expect(db.autopilot_goals[0].status).toBe("met");
    expect(db.autopilot_goals[0].status_changed_by).toBe("cgo");
    expect(rpcCalls.find((c) => c.fn === "suppress_decision")).toBeUndefined();
    expect(db.decisions.find((d) => d.id === "o1")?.status).toBe("expired");
    expect(emitted).toHaveLength(0);
    expect(res.goals_ended).toBe(1);
  });

  it("proposes a next goal only when a goal ended and no suggestion is waiting", async () => {
    const next = { objective: "Get 50 signups", target_metric: "weekly_signups", target_value: 50 };
    db.autopilot_goals.push(goal(G1));
    const { emitDecision } = emitter();
    await applyGoalMoves(T, "run-1", review([], { next_goal: next }), { emitDecision, resolveRepo: noRepo, now: NOW });
    expect(rpcCalls.find((c) => c.fn === "propose_next_autopilot_goal")).toBeUndefined();

    db.autopilot_goals[0].due_date = "2026-09-01";
    await applyGoalMoves(T, "run-2", review([], { next_goal: next }), { emitDecision, resolveRepo: noRepo, now: NOW });
    expect(rpcCalls.filter((c) => c.fn === "propose_next_autopilot_goal")).toHaveLength(1);

    db.autopilot_goals.push(goal(G2, { status: "proposed" }));
    await applyGoalMoves(T, "run-3", review([], { next_goal: next }), { emitDecision, resolveRepo: noRepo, now: NOW });
    expect(rpcCalls.filter((c) => c.fn === "propose_next_autopilot_goal")).toHaveLength(1);
  });

  it("never makes a card for a paid channel without a budget, and ignores a plan change in the output (v2: no second approval)", async () => {
    db.autopilot_goals.push(goal(G1));
    const { emitted, emitDecision } = emitter();
    const raw = review(
      [{ goal_id: G1, status_line: "x", moves: ["meta_ads", "linkedin_ads", "tiktok_ads"].map((t) => ({ target_agent_slug: t, intent: "x", why: "" })) }],
      { plan_change: { add: ["seo"], drop: ["reddit_organic"] } } as unknown as Partial<GoalMoves>,
    );
    await applyGoalMoves(T, "run-1", raw, { emitDecision, resolveRepo: noRepo, now: NOW });
    expect(emitted).toHaveLength(0);
    expect(rpcCalls.filter((c) => c.fn === "pause_channel_by_cgo")).toHaveLength(0);
  });

  it("R2: an organic channel is a move while Autopilot is on: cgo starts its drafts itself; advice only makes none", async () => {
    db.autopilot_goals.push(goal(G1));
    db.tenant_channels.push({ tenant_id: T, channel_slug: "linkedin_organic", autorun: true });
    const { emitted, emitDecision } = emitter();
    const autoRun = vi.fn(async () => true);
    const raw = review([{ goal_id: G1, status_line: "x", moves: [{ target_agent_slug: "linkedin_organic", intent: "Draft three posts on how hosts earn more.", why: "Hosts find us on LinkedIn." }] }]);
    await applyGoalMoves(T, "run-1", raw, { emitDecision, resolveRepo: noRepo, now: NOW, autoRun, meta: { kind: "scheduled", alarm_keys: [], autopilot: true } });
    expect(emitted.map((e) => e.body.target_agent_slug)).toEqual(["linkedin_organic"]);
    expect(emitted[0].body).toMatchObject({ dispatched_by: "cgo", goal_id: G1, intent: "Draft three posts on how hosts earn more." });
    expect(autoRun.mock.calls).toEqual([[T, "d-1"]]);
    expect(db.cgo_notes[0].changed).toEqual([expect.stringMatching(/^Started LinkedIn.*: Draft three posts/)]);

    db.decisions.length = 0;
    db.tenant_channels.push({ tenant_id: OTHER, channel_slug: "linkedin_organic", plan_selected: false, plan_selected_set_by: "founder" });
    const other = emitter();
    await applyGoalMoves(T, "run-2a", raw, { emitDecision: other.emitDecision, resolveRepo: noRepo, now: NOW, autoRun, meta: { kind: "scheduled", alarm_keys: [], autopilot: true } });
    expect(other.emitted).toHaveLength(1);
    db.decisions.length = 0;
    db.tenant_channels.push({ tenant_id: T, channel_slug: "linkedin_organic", plan_selected: false, plan_selected_set_by: "founder" });
    const b = emitter();
    await applyGoalMoves(T, "run-2", raw, { emitDecision: b.emitDecision, resolveRepo: noRepo, now: NOW, autoRun, meta: { kind: "scheduled", alarm_keys: [], autopilot: true } });
    expect(b.emitted).toHaveLength(0);

    const off = emitter();
    await applyGoalMoves(T, "run-3", raw, { emitDecision: off.emitDecision, resolveRepo: noRepo, now: NOW, autoRun, meta: { kind: "scheduled", alarm_keys: [], autopilot: false } });
    expect(off.emitted).toHaveLength(0);
  });

  it("Autopilot off: a proposed move starts nothing but shows as a would-change line", async () => {
    db.autopilot_goals.push(goal(G1));
    const raw = review([
      {
        goal_id: G1,
        status_line: "6 of 20",
        moves: [
          {
            target_agent_slug: "research",
            intent: "Read a year of public renter reviews and sort every complaint by failure type.",
            action: "Sorting a year of renter reviews by failure type.",
            why: "because no booking data is connected for goal 123e4567-e89b-12d3-a456-426614174000, so reviews show which failure to fix first",
          },
        ],
      },
    ]);
    const off = emitter();
    const r = await applyGoalMoves(T, "run-advice", raw, { emitDecision: off.emitDecision, resolveRepo: noRepo, now: NOW, meta: { kind: "scheduled", alarm_keys: [], autopilot: false } });
    expect(off.emitted).toHaveLength(0);
    expect(r.cards_emitted).toBe(0);
    const note = db.cgo_notes.find((n: { run_id?: string }) => n.run_id === "run-advice") as { would_change: string[] };
    expect(note.would_change).toEqual([
      expect.stringMatching(/^Research: Sorting a year of renter reviews by failure type\. No booking data is connected/),
    ]);
    expect(note.would_change[0]).not.toMatch(/123e4567/);
    expect(r.note_visible).toBe(true);
  });

  describe("may cgo run the channel (channel-autorun.ts, 2026-10-12)", () => {
    const acts = { kind: "scheduled" as const, alarm_keys: [], autopilot: true };
    const raw = () => review([{ goal_id: G1, status_line: "x", moves: [{ target_agent_slug: "linkedin_organic", intent: "Draft three posts on how hosts earn more.", why: "Hosts find us on LinkedIn." }] }]);
    const ON = "2026-10-12T09:00:00.000Z";

    it("the founder set it to ask first after the latest ON: the card is filed for the founder, cgo does not start it", async () => {
      db.autopilot_goals.push(goal(G1));
      (db.cgo_autopilot_state ??= []).push({ tenant_id: T, on_at: ON });
      db.tenant_channels.push({ tenant_id: T, channel_slug: "linkedin_organic", autorun: false, autorun_set_by: "founder", autorun_set_at: "2026-10-12T10:00:00.000Z" });
      db.tenant_channels.push({ tenant_id: OTHER, channel_slug: "linkedin_organic", autorun: true });
      const { emitted, emitDecision } = emitter();
      const autoRun = vi.fn(async () => true);
      await applyGoalMoves(T, "run-1", raw(), { emitDecision, resolveRepo: noRepo, now: NOW, autoRun, meta: acts });
      expect(emitted.map((e) => e.body.target_agent_slug)).toEqual(["linkedin_organic"]);
      expect(autoRun).not.toHaveBeenCalled();
      expect(db.cgo_notes[0]?.changed ?? []).toEqual([]);
    });

    it("no row at all: under Autopilot cgo starts it", async () => {
      db.autopilot_goals.push(goal(G1));
      const { emitted, emitDecision } = emitter();
      const autoRun = vi.fn(async () => true);
      await applyGoalMoves(T, "run-1", raw(), { emitDecision, resolveRepo: noRepo, now: NOW, autoRun, meta: acts });
      expect(emitted).toHaveLength(1);
      expect(autoRun.mock.calls).toEqual([[T, "d-1"]]);
    });

    it("a plan-written off, or a founder off from before the latest ON: cgo starts it", async () => {
      db.autopilot_goals.push(goal(G1));
      (db.cgo_autopilot_state ??= []).push({ tenant_id: T, on_at: ON });
      db.tenant_channels.push({ tenant_id: T, channel_slug: "linkedin_organic", autorun: false, autorun_set_by: "founder", autorun_set_at: "2026-10-01T10:00:00.000Z" });
      const autoRun = vi.fn(async () => true);
      await applyGoalMoves(T, "run-1", raw(), { emitDecision: emitter().emitDecision, resolveRepo: noRepo, now: NOW, autoRun, meta: acts });
      expect(autoRun.mock.calls).toEqual([[T, "d-1"]]);
    });

    it("switch on + Autopilot on: cgo starts it", async () => {
      db.autopilot_goals.push(goal(G1));
      db.tenant_channels.push({ tenant_id: T, channel_slug: "linkedin_organic", autorun: true });
      const autoRun = vi.fn(async () => true);
      await applyGoalMoves(T, "run-1", raw(), { emitDecision: emitter().emitDecision, resolveRepo: noRepo, now: NOW, autoRun, meta: acts });
      expect(autoRun.mock.calls).toEqual([[T, "d-1"]]);
    });

    it("enqueued with Autopilot on, turned off before apply: the card is filed, nothing starts (live re-check)", async () => {
      db.autopilot_goals.push(goal(G1));
      db.tenant_channels.push({ tenant_id: T, channel_slug: "linkedin_organic", autorun: true, autorun_set_by: "founder" });
      const { emitted, emitDecision } = emitter();
      const autoRun = vi.fn(async () => true);
      await applyGoalMoves(T, "run-1", raw(), { emitDecision, resolveRepo: noRepo, now: NOW, autoRun, autopilotNow: async () => false, meta: acts });
      expect(emitted).toHaveLength(1);
      expect(autoRun).not.toHaveBeenCalled();
    });

    it("Autopilot off: nothing starts, whatever the switch says", async () => {
      db.autopilot_goals.push(goal(G1));
      db.tenant_channels.push({ tenant_id: T, channel_slug: "linkedin_organic", autorun: true });
      const autoRun = vi.fn(async () => true);
      await applyGoalMoves(T, "run-1", raw(), { emitDecision: emitter().emitDecision, resolveRepo: noRepo, now: NOW, autoRun, meta: { ...acts, autopilot: false } });
      expect(autoRun).not.toHaveBeenCalled();
    });

    it("an unreadable switch fails closed: the card is filed, nothing starts", async () => {
      db.autopilot_goals.push(goal(G1));
      db.tenant_channels.push({ tenant_id: T, channel_slug: "linkedin_organic", autorun: true });
      const { emitted, emitDecision } = emitter();
      const autoRun = vi.fn(async () => true);
      const autorunChannels = vi.fn(async () => {
        throw new Error("db down");
      });
      await applyGoalMoves(T, "run-1", raw(), { emitDecision, resolveRepo: noRepo, now: NOW, autoRun, autorunChannels, meta: acts });
      expect(autorunChannels).toHaveBeenCalledWith(T);
      expect(emitted).toHaveLength(1);
      expect(autoRun).not.toHaveBeenCalled();
    });

    it("research is not a channel: it still starts with no switch", async () => {
      db.autopilot_goals.push(goal(G1));
      const autoRun = vi.fn(async () => true);
      await applyGoalMoves(
        T,
        "run-1",
        review([{ goal_id: G1, moves: [{ target_agent_slug: "research", intent: "count cancelled trips", why: "" }] }]),
        { emitDecision: emitter().emitDecision, resolveRepo: noRepo, now: NOW, autoRun, meta: acts },
      );
      expect(autoRun).toHaveBeenCalledTimes(1);
    });
  });

  it("CGO_TARGETS holds no channel slug", () => {
    for (const c of CHANNELS) expect(CGO_TARGETS.has(c.slug)).toBe(false);
  });
});

describe("applyGoalMoves: the ad channels under an ad budget", () => {
  const budget = (over: Row = {}) => ({
    id: "b-1",
    tenant_id: T,
    status: "active",
    monthly_usd: 1000,
    spent_usd: 100,
    held_usd: 150,
    daily_limit_usd: null,
    ...over,
  });
  const adMoves = () =>
    review([
      {
        goal_id: G1,
        status_line: "6 of 20 signups",
        moves: [
          { target_agent_slug: "meta_ads", intent: "test a $30/day ad set on the best creative", why: "" },
          { target_agent_slug: "blog", intent: "write a blog post", why: "" },
        ],
      },
    ]);
  const acts = { kind: "scheduled" as const, alarm_keys: [], autopilot: true };

  it("budget on: a meta_ads move becomes a cgo card that cgo starts itself; another channel is still never a move", async () => {
    db.autopilot_goals.push(goal(G1));
    db.ad_budgets = [budget()];
    db.tenant_channels.push({ tenant_id: T, channel_slug: "meta_ads", autorun: true });
    const { emitted, emitDecision } = emitter();
    const autoRun = vi.fn(async () => true);
    await applyGoalMoves(T, "run-1", adMoves(), { emitDecision, resolveRepo: noRepo, now: NOW, autoRun, meta: acts });
    expect(emitted.map((e) => e.body.target_agent_slug)).toEqual(["meta_ads"]);
    expect(emitted[0].body).toMatchObject({ intent: "test a $30/day ad set on the best creative", dispatched_by: "cgo", goal_id: G1 });
    expect(autoRun.mock.calls).toEqual([[T, "d-1"]]);
    expect(db.cgo_notes[0].changed).toEqual(["Started Meta Ads: test a $30/day ad set on the best creative"]);
  });

  it("the ads clock pings the founder only when money moved: a started research task stays on the page", async () => {
    db.autopilot_goals.push(goal(G1));
    db.ad_budgets = [budget()];
    const clock = { kind: "alarm" as const, alarm_keys: [], autopilot: true, ads_clock: true };
    const autoRun = vi.fn(async () => true);
    const quiet = await applyGoalMoves(
      T,
      "run-q",
      review([{ goal_id: G1, moves: [{ target_agent_slug: "research", intent: "count cancelled trips", why: "" }] }]),
      { emitDecision: emitter().emitDecision, resolveRepo: noRepo, now: NOW, autoRun, meta: clock },
    );
    expect(db.cgo_notes.at(-1)?.changed).toEqual(["Started research: count cancelled trips"]);
    expect(quiet).toMatchObject({ note_visible: true, note_notify: false });
  });

  it("the same started task from any other review still pings", async () => {
    db.autopilot_goals.push(goal(G1));
    db.ad_budgets = [budget()];
    const res = await applyGoalMoves(
      T,
      "run-d",
      review([{ goal_id: G1, moves: [{ target_agent_slug: "research", intent: "count cancelled trips", why: "" }] }]),
      { emitDecision: emitter().emitDecision, resolveRepo: noRepo, now: NOW, autoRun: vi.fn(async () => true), meta: { kind: "alarm", alarm_keys: [], autopilot: true } },
    );
    expect(res).toMatchObject({ note_visible: true, note_notify: true });
  });

  it("budget on but Meta set to ask first: the card is filed, cgo does not start it (ad channels obey the switch)", async () => {
    db.autopilot_goals.push(goal(G1));
    db.ad_budgets = [budget()];
    (db.cgo_autopilot_state ??= []).push({ tenant_id: T, on_at: "2026-10-12T09:00:00.000Z" });
    db.tenant_channels.push({ tenant_id: T, channel_slug: "meta_ads", autorun: false, autorun_set_by: "founder", autorun_set_at: "2026-10-12T10:00:00.000Z" });
    const { emitted, emitDecision } = emitter();
    const autoRun = vi.fn(async () => true);
    await applyGoalMoves(T, "run-1", adMoves(), { emitDecision, resolveRepo: noRepo, now: NOW, autoRun, meta: acts });
    expect(emitted.map((e) => e.body.target_agent_slug)).toEqual(["meta_ads"]);
    expect(autoRun).not.toHaveBeenCalled();
  });

  it("a Meta run the ads clock starts is money moving: it pings", async () => {
    db.autopilot_goals.push(goal(G1));
    db.ad_budgets = [budget()];
    db.tenant_channels.push({ tenant_id: T, channel_slug: "meta_ads", autorun: true });
    const clock = { kind: "alarm" as const, alarm_keys: [], autopilot: true, ads_clock: true };
    const res = await applyGoalMoves(T, "run-a", adMoves(), { emitDecision: emitter().emitDecision, resolveRepo: noRepo, now: NOW, autoRun: vi.fn(async () => true), meta: clock });
    expect(db.cgo_notes.at(-1)?.changed).toEqual(["Started Meta Ads: test a $30/day ad set on the best creative"]);
    expect(res).toMatchObject({ note_visible: true, note_notify: true });
  });

  it("T13: no budget, the same review never targets a channel and starts nothing", async () => {
    db.autopilot_goals.push(goal(G1));
    const { emitted, emitDecision } = emitter();
    const autoRun = vi.fn(async () => true);
    await applyGoalMoves(T, "run-1", adMoves(), { emitDecision, resolveRepo: noRepo, now: NOW, autoRun, meta: acts });
    expect(emitted).toHaveLength(0);
    expect(autoRun).not.toHaveBeenCalled();
  });

  it("T13: a budget but Autopilot switched off since the review started: no channel card", async () => {
    db.autopilot_goals.push(goal(G1));
    db.ad_budgets = [budget()];
    autopilotOn = false;
    const a = emitter();
    await applyGoalMoves(T, "run-1", adMoves(), { emitDecision: a.emitDecision, resolveRepo: noRepo, now: NOW, meta: acts });
    expect(a.emitted).toHaveLength(0);
  });

  it("T13: a stopped budget, or another tenant's budget, starts nothing", async () => {
    db.autopilot_goals.push(goal(G1));
    db.ad_budgets = [budget({ status: "stopped" }), budget({ id: "b-2", tenant_id: OTHER })];
    const { emitted, emitDecision } = emitter();
    await applyGoalMoves(T, "run-1", adMoves(), { emitDecision, resolveRepo: noRepo, now: NOW, meta: acts });
    expect(emitted).toHaveLength(0);
  });

  it("advice only (autopilot off for the review): a budget changes nothing", async () => {
    db.autopilot_goals.push(goal(G1));
    db.ad_budgets = [budget()];
    const { emitted, emitDecision } = emitter();
    await applyGoalMoves(T, "run-1", adMoves(), {
      emitDecision,
      resolveRepo: noRepo,
      now: NOW,
      meta: { kind: "scheduled", alarm_keys: [], autopilot: false },
    });
    expect(emitted).toHaveLength(0);
  });

  it("the review's context lists the ad channels and the budget left only while the budget is on", async () => {
    tenantTier = "pro";
    db.autopilot_goals.push(goal(G1));
    enqueueAgentRun.mockResolvedValue({ run_id: "r-1" });
    await enqueueGoalOwnerRun({ tenant_id: T, reason: "goal_set", now: NOW });
    const off = enqueueAgentRun.mock.calls[0][0].payload.memory.cgo_goals;
    expect(off.allowed_agents).not.toContain("meta_ads");
    expect(off.allowed_agents).not.toContain("google_ads");
    expect(off).not.toHaveProperty("ad_budget");

    db.ad_budgets = [budget()];
    await enqueueGoalOwnerRun({ tenant_id: T, reason: "goal_set", now: NOW });
    const on = enqueueAgentRun.mock.calls[1][0].payload.memory.cgo_goals;
    expect(on.allowed_agents).toEqual(expect.arrayContaining(["meta_ads", "google_ads"]));
    expect(on.allowed_agents).toContain("linkedin_ads");
    expect(on.allowed_agents).not.toContain("blog");
    expect(on.allowed_agents).toEqual(expect.arrayContaining(["reddit_organic", "email_marketing"]));
    expect(on.ad_budget).toEqual({
      monthly_usd: 1000,
      this_month_cap_usd: 1000,
      spent_this_month_usd: 100,
      held_rest_of_month_usd: 150,
      left_usd: 750,
      daily_limit_usd: null,
      days_left_in_month: 10,
      next_month_starts: "2026-10-01",
      spare_daily_capacity_usd: 90,
      in_words: "$750.00 of this month's ad budget is not spent or held yet; up to $90.00 a day of new ad spend still fits.",
    });
    expect(on.spend_pace).toMatchObject({ actual_month_usd: 100, live_ads_per_day_usd: 0 });
    expect(off).not.toHaveProperty("spend_pace");
  });
});

describe("applyGoalMoves v2: goal changes, pauses, the note", () => {
  const rev = (over: Partial<GoalRow> = {}) => new Map([[G1, goalRev(goal(G1, over) as GoalRow)]]);

  it("changes a goal, keeps the old values for undo, and says so in the note", async () => {
    db.autopilot_goals.push(goal(G1));
    const { emitDecision } = emitter();
    const res = await applyGoalMoves(
      T,
      "run-1",
      review([{ goal_id: G1, status_line: "6 of 20", moves: [{ target_agent_slug: "pm", intent: "x", why: "" }] }], {
        goal_changes: [{ goal_id: G1, objective: "Reach 3,000 MRR", target_metric: "mrr", target_value: 3000, why: "Signups are free; revenue is the goal." }],
      }),
      { emitDecision, resolveRepo: noRepo, now: NOW, reviewedRevs: rev(), meta: { kind: "scheduled", alarm_keys: ["due:first"], autopilot: true } },
    );
    const g = db.autopilot_goals[0];
    expect(g).toMatchObject({ objective: "Reach 3,000 MRR", target_metric: "mrr", target_value: 3000, current_value: null });
    expect((g.cgo_undo as Row).prev).toMatchObject({ target_value: 20, target_metric: "weekly_signups", current_value: 6 });
    expect(res.goals_changed).toBe(1);
    expect(g.cgo_status_line).toBe("Not counted yet (aiming for $3,000 MRR), 35 days left");
    expect(res.cards_emitted).toBe(0);
    const note = db.cgo_notes[0];
    expect(note.changed).toEqual([
      'Goal "Get 20 signups": now "Reach 3,000 MRR", measured by mrr, target 20 to $3,000. Signups are free; revenue is the goal.',
    ]);
    expect(note).toMatchObject({ tenant_id: T, run_id: "run-1", kind: "scheduled", alarm_keys: ["due:first"] });
    expect(res.note_visible).toBe(true);
    const change = rpcCalls.find((c) => c.fn === "write_autopilot_goal" && (c.args.p_values as Row).cgo_undo);
    expect(change?.args).toMatchObject({
      p_tenant_id: T,
      p_op: "update",
      p_goal_id: G1,
      p_actor_source: "cgo",
      p_run_id: "run-1",
      p_why: "Signups are free; revenue is the goal.",
      p_expect: { status: "active", objective: "Get 20 signups", target_metric: "weekly_signups", target_value: 20 },
    });
  });

  it("a met goal is recorded through write_autopilot_goal as cgo's, with the run and a why", async () => {
    db.autopilot_goals.push(goal(G1, { current_value: 20 }));
    const { emitDecision } = emitter();
    await applyGoalMoves(T, "run-1", review([]), { emitDecision, resolveRepo: noRepo, now: NOW, meta: { kind: "scheduled", alarm_keys: [], autopilot: true } });
    const met = rpcCalls.find((c) => c.fn === "write_autopilot_goal" && (c.args.p_values as Row).status === "met");
    expect(met?.args).toMatchObject({ p_actor_source: "cgo", p_run_id: "run-1", p_expect: { status: "active", current_value: 20, target_value: 20 } });
    expect(String(met?.args.p_why)).toMatch(/reached the target/);
    expect(db.autopilot_goals[0].status).toBe("met");
  });

  it("a new metric resets the number and re-classifies how it is measured", async () => {
    db.autopilot_goals.push(goal(G1, { baseline_value: 2 }));
    const { emitDecision } = emitter();
    await applyGoalMoves(T, "run-1", review([], { goal_changes: [{ goal_id: G1, objective: "Get 10 paying customers", target_metric: "paying_customers", target_value: 10, why: "Signups are not the constraint." }] }), {
      emitDecision,
      resolveRepo: noRepo,
      now: NOW,
    });
    const g = db.autopilot_goals[0];
    expect(g).toMatchObject({ target_metric: "paying_customers", current_value: null, baseline_value: null });
    expect((g.cgo_undo as Row).prev).toMatchObject({ target_metric: "weekly_signups", current_value: 6, baseline_value: 2 });
  });

  it("refuses a past due date, a non-positive target, an ended goal and a goal edited since the review read it", async () => {
    db.autopilot_goals.push(goal(G1), goal(G2, { current_value: 25 }));
    const { emitDecision } = emitter();
    const res = await applyGoalMoves(
      T,
      "run-1",
      review([], {
        goal_changes: [
          { goal_id: G1, due_date: "2026-09-01", why: "x" },
          { goal_id: G1, target_value: 0, why: "x" },
          { goal_id: G2, target_value: 40, why: "x" },
        ],
      }),
      { emitDecision, resolveRepo: noRepo, now: NOW },
    );
    expect(res.goals_changed).toBe(0);
    expect(db.autopilot_goals[0].cgo_undo).toBeUndefined();

    const stale = await applyGoalMoves(T, "run-2", review([], { goal_changes: [{ goal_id: G1, target_value: 15, why: "x" }] }), {
      emitDecision,
      resolveRepo: noRepo,
      now: NOW,
      reviewedRevs: rev({ target_value: 99 }),
    });
    expect(stale.goals_changed).toBe(0);
    expect(db.autopilot_goals[0].target_value).toBe(20);
  });

  it("a channel outside the plan: cgo closes its waiting cards and says so; with none waiting it records a refusal", async () => {
    db.autopilot_goals.push(goal(G1));
    const { emitDecision } = emitter();
    rpcResult.pause_channel_by_cgo = "not_plan";
    rpcResult.close_channel_actions_on_cgo_pause = 8;
    const res = await applyGoalMoves(T, "run-1", review([], { channel_changes: [{ channel_slug: "x_organic", action: "pause", why: "21 cards, none acted on." }] }), {
      emitDecision,
      resolveRepo: noRepo,
      now: NOW,
      meta: { kind: "alarm", alarm_keys: [], autopilot: true },
      evidence: perItem("x_organic"),
    });
    expect(res.channels_paused).toBe(0);
    expect(rpcCalls.filter((c) => c.fn === "close_channel_actions_on_cgo_pause").map((c) => c.args)).toEqual([
      { p_tenant_id: T, p_channel_slug: "x_organic", p_run_id: "run-1", p_why: "21 cards, none acted on." },
    ]);
    expect(db.cgo_notes[0].changed).toEqual([expect.stringMatching(/^Closed 8 waiting .* cards\. 21 cards, none acted on\.$/)]);
    expect(res.note_visible).toBe(true);

    rpcResult.close_channel_actions_on_cgo_pause = 0;
    await applyGoalMoves(T, "run-2", review([], { channel_changes: [{ channel_slug: "x_organic", action: "pause", why: "Still nothing." }] }), {
      emitDecision,
      resolveRepo: noRepo,
      now: NOW,
      meta: { kind: "alarm", alarm_keys: [], autopilot: true },
      evidence: perItem("x_organic"),
    });
    expect(db.cgo_notes[1].changed).toEqual([]);
    expect(db.cgo_notes[1].refused).toEqual([expect.stringContaining("not in the plan")]);
  });

  it("pauses a channel the plan picked and records why; a founder's own channel becomes a question instead", async () => {
    db.autopilot_goals.push(goal(G1));
    db.tenant_channels.push({ tenant_id: T, channel_slug: "reddit_organic" }, { tenant_id: OTHER, channel_slug: "reddit_organic" });
    const { emitDecision } = emitter();
    rpcResult.pause_channel_by_cgo = "ok";
    const res = await applyGoalMoves(T, "run-1", review([], { channel_changes: [{ channel_slug: "reddit_organic", action: "pause", why: "9 posts untouched for 9 days." }, { channel_slug: "not_a_channel", action: "pause", why: "x" }] }), {
      emitDecision,
      resolveRepo: noRepo,
      now: NOW,
      meta: { kind: "alarm", alarm_keys: [], autopilot: true },
      evidence: perItem("reddit_organic"),
    });
    expect(rpcCalls.filter((c) => c.fn === "pause_channel_by_cgo").map((c) => c.args)).toEqual([
      { p_tenant_id: T, p_channel_slug: "reddit_organic", p_reason: "9 posts untouched for 9 days.", p_run_id: "run-1" },
    ]);
    expect(res.channels_paused).toBe(1);
    expect(rpcCalls.filter((c) => c.fn === "close_channel_actions_on_cgo_pause").map((c) => c.args)).toEqual([
      { p_tenant_id: T, p_channel_slug: "reddit_organic", p_run_id: "run-1", p_why: "9 posts untouched for 9 days." },
    ]);
    expect(db.cgo_notes[0].changed).toEqual(["Paused Reddit. 9 posts untouched for 9 days."]);
    expect(res.note_visible).toBe(true);

    rpcResult.pause_channel_by_cgo = "founder_owned";
    const res2 = await applyGoalMoves(T, "run-2", review([], { channel_changes: [{ channel_slug: "seo", action: "pause", why: "No clicks in 14 days." }] }), {
      emitDecision,
      resolveRepo: noRepo,
      now: NOW,
      meta: { kind: "alarm", alarm_keys: [], autopilot: true },
      evidence: perItem("seo"),
    });
    expect(res2.channels_paused).toBe(0);
    expect(rpcCalls.filter((c) => c.fn === "close_channel_actions_on_cgo_pause")).toHaveLength(1);
    expect(db.cgo_notes[1].need).toEqual(["SEO: No clicks in 14 days. You added it, so I left it running. Pause it if you agree."]);
    expect(db.cgo_questions).toEqual([expect.objectContaining({ tenant_id: T, topic_key: "channel:seo", status: "open", default_action: null, asked_run_id: "run-2" })]);
    expect(res2.note_visible).toBe(true);

    const res3 = await applyGoalMoves(T, "run-3", review([], { channel_changes: [{ channel_slug: "seo", action: "pause", why: "No clicks in 15 days." }] }), {
      emitDecision,
      resolveRepo: noRepo,
      now: NOW,
      meta: { kind: "scheduled", alarm_keys: [], autopilot: true },
      evidence: perItem("seo"),
    });
    expect(db.cgo_questions).toHaveLength(1);
    expect(db.cgo_notes[2].need).toEqual([]);
    expect(db.cgo_notes[2].refused).toEqual(["Pause SEO: the founder added it."]);
    expect(res3.note_visible).toBe(false);
  });

  it("writes the next check-in cgo chose, clamped to 2-14 days (7 when it says nothing)", async () => {
    db.autopilot_goals.push(goal(G1));
    const { emitDecision } = emitter();
    for (const [days, expected] of [[3, 3], [30, 14], [0, 2], [undefined, 7]] as const) {
      await applyGoalMoves(T, `run-${expected}-${days}`, review([], { next_review_in_days: days }), { emitDecision, resolveRepo: noRepo, now: NOW });
    }
    const gaps = db.cgo_notes.map((n) => (Date.parse(String(n.next_review_at)) - NOW.getTime()) / 86_400_000);
    expect(gaps).toEqual([5, 14, 5, 7]);
    await applyGoalMoves(T, "run-behind", review([], { next_review_in_days: 2 }), {
      emitDecision,
      resolveRepo: noRepo,
      now: NOW,
      meta: { kind: "alarm", alarm_keys: [], autopilot: true, behind_pace: true },
    });
    expect((Date.parse(String(db.cgo_notes.at(-1)?.next_review_at)) - NOW.getTime()) / 86_400_000).toBe(2);
    await applyGoalMoves(T, "run-deadline", review([], { next_review_in_days: 1 }), {
      emitDecision,
      resolveRepo: noRepo,
      now: NOW,
      meta: { kind: "alarm", alarm_keys: [], autopilot: true, behind_required_near: true },
    });
    expect((Date.parse(String(db.cgo_notes.at(-1)?.next_review_at)) - NOW.getTime()) / 86_400_000).toBe(1);
    await applyGoalMoves(T, "run-no-flag", review([], { next_review_in_days: 1 }), {
      emitDecision,
      resolveRepo: noRepo,
      now: NOW,
      meta: { kind: "alarm", alarm_keys: [], autopilot: true, behind_pace: true },
    });
    expect((Date.parse(String(db.cgo_notes.at(-1)?.next_review_at)) - NOW.getTime()) / 86_400_000).toBe(2);
  });
});

describe("autopilot off (the default): advice only", () => {
  const off = { kind: "scheduled" as const, alarm_keys: ["silent:x"], autopilot: false };

  it("changes nothing: no goal write, no pause, no card, no met, no next goal; the note carries what cgo would change", async () => {
    db.autopilot_goals.push(goal(G1), goal(G2, { current_value: 25 }));
    db.tenant_channels.push({ tenant_id: T, channel_slug: "reddit_organic" });
    rpcResult.pause_channel_by_cgo = "ok";
    const { emitted, emitDecision } = emitter();
    const res = await applyGoalMoves(
      T,
      "run-1",
      review([{ goal_id: G1, status_line: "6 of 20", moves: [{ target_agent_slug: "pm", intent: "x", why: "" }] }], {
        goal_changes: [{ goal_id: G1, target_value: 30, why: "Ahead of pace." }],
        channel_changes: [{ channel_slug: "reddit_organic", action: "pause", why: "Ignored for 9 days." }],
        next_goal: { objective: "Next", target_metric: "m", target_value: 5 },
        next_review_in_days: 3,
      }),
      { emitDecision, resolveRepo: noRepo, now: NOW, meta: off },
    );
    expect(emitted).toHaveLength(0);
    expect(rpcCalls.filter((c) => c.fn !== "write_autopilot_goal")).toHaveLength(0);
    for (const c of rpcCalls) expect(Object.keys(c.args.p_values as Row).sort()).toEqual(["cgo_status_at", "cgo_status_line"]);
    expect(db.autopilot_goals[0]).toMatchObject({ target_value: 20, cgo_status_line: "6 of 20 weekly signups, 35 days left" });
    expect(db.autopilot_goals[0].cgo_undo).toBeUndefined();
    expect(db.autopilot_goals[1].status).toBe("active");
    expect(db.tenant_channels[0].cgo_reason).toBeUndefined();
    expect(res).toMatchObject({ goals_changed: 0, channels_paused: 0, goals_ended: 0, next_goal_proposed: false, note_visible: true });
    const note = db.cgo_notes[0];
    expect(note.changed).toEqual([]);
    expect(note.would_change).toEqual(["Pause Reddit. Ignored for 9 days.", expect.stringMatching(/^Pm: /)]);
    expect(db.cgo_questions).toEqual([expect.objectContaining({ topic_key: `goal:${G1}`, default_action: null })]);
    expect(note.alarm_keys).toEqual([]);
    expect((Date.parse(String(note.next_review_at)) - NOW.getTime()) / 86_400_000).toBe(7);
  });

  it("a goal edit or a Not now does not wake cgo; the weekly check still can", async () => {
    autopilotOn = false;
    db.autopilot_goals.push(goal(G1));
    expect(await enqueueGoalOwnerRun({ tenant_id: T, reason: "goal_set", now: NOW })).toEqual({ enqueued: false, skipped: "autopilot_off" });
    enqueueAgentRun.mockResolvedValueOnce({ run_id: "r-w" });
    const r = await enqueueGoalOwnerRun({ tenant_id: T, reason: "daily_check", check: { kind: "scheduled", reasons: ["review_due"], alarm_keys: [] }, now: NOW });
    expect(r).toEqual({ enqueued: true, run_id: "r-w" });
    expect(enqueueAgentRun.mock.calls[0][0].payload.autopilot).toBe(false);
  });

  it("reviewMetaFromPayload: only an explicit true acts", () => {
    expect(reviewMetaFromPayload({ note_kind: "alarm", alarm_keys: ["a"], autopilot: true })).toEqual({
      kind: "alarm",
      alarm_keys: ["a"],
      autopilot: true,
      prev_idle: false,
      saw: [],
      behind_pace: false,
      behind_required_near: false,
      never_approved: [],
      rejected_channels: [],
      founder_channels: [],
      last_need: [],
    });
    expect(reviewMetaFromPayload({}).autopilot).toBe(false);
    expect(reviewMetaFromPayload({ autopilot: "yes" }).autopilot).toBe(false);
  });
});

describe("enqueueGoalOwnerRun", () => {
  it("runs no review for a tenant with no active goal, but withdraws the open cards of the goal just paused", async () => {
    db.autopilot_goals.push(goal(G1, { status: "paused" }));
    db.decisions.push({ id: "c1", tenant_id: T, decision_class: "cgo.dispatch-specialist", status: "proposed", body: { goal_id: G1 } });
    db.decisions.push({ id: "c-other", tenant_id: OTHER, decision_class: "cgo.dispatch-specialist", status: "proposed", body: { goal_id: GX } });
    const r = await enqueueGoalOwnerRun({ tenant_id: T, reason: "goal_set", now: NOW });
    expect(r).toEqual({ enqueued: false, skipped: "no_active_goals" });
    expect(enqueueAgentRun).not.toHaveBeenCalled();
    expect(db.decisions.find((d) => d.id === "c1")?.status).toBe("expired");
    expect(db.decisions.find((d) => d.id === "c-other")?.status).toBe("proposed");
  });

  it("stops at 3 goal reviews a UTC day", async () => {
    db.autopilot_goals.push(goal(G1));
    for (let i = 0; i < 3; i++) {
      db.agent_runs.push({ tenant_id: T, agent_slug: "cgo", payload: { stage: "own_goals", reason: "goal_set" }, enqueued_at: "2026-09-26T0" + i + ":00:00.000Z" });
    }
    const r = await enqueueGoalOwnerRun({ tenant_id: T, reason: "goal_set", now: NOW });
    expect(r).toEqual({ enqueued: false, skipped: "daily_cap" });
  });

  describe("the cap under an ad budget (G7)", () => {
    const budget = (over: Row = {}) => ({ id: "b-1", tenant_id: T, status: "active", monthly_usd: 1000, daily_limit_usd: null, ...over });
    const priorReviews = (n: number, reason = "ad_budget_review") => {
      for (let i = 0; i < n; i++) {
        db.agent_runs.push({ tenant_id: T, agent_slug: "cgo", payload: { stage: "own_goals", reason }, enqueued_at: new Date(Date.parse("2026-09-26T00:00:00Z") + i * 600_000).toISOString() });
      }
    };

    it("a tenant with an active budget and Autopilot on gets 12 reviews a day, not 3", async () => {
      db.autopilot_goals.push(goal(G1));
      db.ad_budgets = [budget()];
      priorReviews(GOAL_OWNER_DAILY_CAP_AD_BUDGET - 1);
      expect(await goalOwnerDailyCap(T, NOW)).toBe(GOAL_OWNER_DAILY_CAP_AD_BUDGET);
      enqueueAgentRun.mockResolvedValueOnce({ run_id: "r-12" });
      const r = await enqueueGoalOwnerRun({ tenant_id: T, reason: "ad_budget_review", now: NOW });
      expect(r).toEqual({ enqueued: true, run_id: "r-12" });
      const arg = enqueueAgentRun.mock.calls[0][0];
      expect(arg.cron_dedupe_key).toBe(`${T}:cgo-budget:2026-09-26:h12`);
      expect(arg.payload).toMatchObject({ reason: "ad_budget_review", note_kind: "alarm", alarm_keys: [AD_BUDGET_REVIEW_NOTE_KEY] });
      db.agent_runs.push({ tenant_id: T, agent_slug: "cgo", payload: { stage: "own_goals", reason: "ad_budget_review" }, enqueued_at: "2026-09-26T11:30:00.000Z" });
      expect(await enqueueGoalOwnerRun({ tenant_id: T, reason: "ad_budget_review", now: NOW })).toEqual({ enqueued: false, skipped: "daily_cap" });
    });

    it("founder wakes and budget reviews never use up each other's slots", async () => {
      db.autopilot_goals.push(goal(G1));
      db.ad_budgets = [budget()];
      for (let i = 0; i < 12; i++) {
        db.agent_runs.push({ tenant_id: T, agent_slug: "cgo", payload: { stage: "own_goals", reason: "goal_set" }, enqueued_at: new Date(Date.parse("2026-09-26T00:10:00Z") + i * 600_000).toISOString() });
      }
      enqueueAgentRun.mockResolvedValueOnce({ run_id: "r-b" });
      expect(await enqueueGoalOwnerRun({ tenant_id: T, reason: "ad_budget_review", now: NOW })).toEqual({ enqueued: true, run_id: "r-b" });
      db.agent_runs = db.agent_runs.filter((r) => (r.payload as Row).reason === "ad_budget_review");
      priorReviews(11);
      enqueueAgentRun.mockResolvedValueOnce({ run_id: "r-f" });
      const r = await enqueueGoalOwnerRun({ tenant_id: T, reason: "goal_set", now: NOW });
      expect(r).toEqual({ enqueued: true, run_id: "r-f" });
      expect(enqueueAgentRun.mock.calls[1][0].cron_dedupe_key).toBe(`${T}:cgo-own:2026-09-26:1`);
    });

    it("the ads clock skips a wake within 3 hours of any other review, and wakes after", async () => {
      db.autopilot_goals.push(goal(G1));
      db.ad_budgets = [budget()];
      db.agent_runs.push({ tenant_id: T, agent_slug: "cgo", payload: { stage: "own_goals", reason: "daily_check" }, enqueued_at: "2026-09-26T10:00:00.000Z" });
      expect(await enqueueGoalOwnerRun({ tenant_id: T, reason: "ad_budget_review", now: NOW })).toEqual({ enqueued: false, skipped: "recent_review" });
      expect(enqueueAgentRun).not.toHaveBeenCalled();
      db.agent_runs = [
        { tenant_id: OTHER, agent_slug: "cgo", payload: { stage: "own_goals", reason: "daily_check" }, enqueued_at: "2026-09-26T11:00:00.000Z" },
        { tenant_id: T, agent_slug: "cgo", payload: { stage: "own_goals", reason: "daily_check" }, enqueued_at: "2026-09-26T08:59:00.000Z" },
      ];
      enqueueAgentRun.mockResolvedValueOnce({ run_id: "r-q" });
      expect(await enqueueGoalOwnerRun({ tenant_id: T, reason: "ad_budget_review", now: NOW })).toEqual({ enqueued: true, run_id: "r-q" });
    });

    it("a clean Reddit action (quiet_ok) takes the 3-hour quiet window; a Reddit failure still wakes at once", async () => {
      db.autopilot_goals.push(goal(G1));
      db.ad_budgets = [budget()];
      db.agent_runs.push({ tenant_id: T, agent_slug: "cgo", payload: { stage: "own_goals", reason: "reddit_ads_change" }, enqueued_at: "2026-09-26T11:50:00.000Z" });
      const clean = await enqueueGoalOwnerRun({ tenant_id: T, reason: "reddit_ads_change", reddit: { incident_id: "a2:executed", issues: ["Reddit action a2: executed."], quiet_ok: true }, now: NOW });
      expect(clean).toEqual({ enqueued: false, skipped: "recent_review" });
      expect(enqueueAgentRun).not.toHaveBeenCalled();
      enqueueAgentRun.mockResolvedValueOnce({ run_id: "r-fail" });
      const failed = await enqueueGoalOwnerRun({ tenant_id: T, reason: "reddit_ads_change", reddit: { incident_id: "a3:outcome_unknown", issues: ["Reddit action a3: outcome_unknown."] }, now: NOW });
      expect(failed).toEqual({ enqueued: true, run_id: "r-fail" });
      expect(enqueueAgentRun.mock.calls[0][0].cron_dedupe_key).toBe(`${T}:cgo-reddit:a3:outcome_unknown`);
      db.agent_runs = [{ tenant_id: T, agent_slug: "cgo", payload: { stage: "own_goals", reason: "reddit_ads_change" }, enqueued_at: "2026-09-26T08:00:00.000Z" }];
      enqueueAgentRun.mockResolvedValueOnce({ run_id: "r-late" });
      expect(await enqueueGoalOwnerRun({ tenant_id: T, reason: "reddit_ads_change", reddit: { incident_id: "a4:executed", issues: ["Reddit action a4: executed."], quiet_ok: true }, now: NOW })).toEqual({ enqueued: true, run_id: "r-late" });
      expect(enqueueAgentRun.mock.calls[1][0].payload.memory.cgo_goals.wake.reddit).toEqual({ incident_id: "a4:executed", issues: ["Reddit action a4: executed."] });
    });

    it("no budget (or a stopped one, or Autopilot off) keeps the cap at 3", async () => {
      db.autopilot_goals.push(goal(G1));
      db.ad_budgets = [];
      expect(await goalOwnerDailyCap(T, NOW)).toBe(GOAL_OWNER_DAILY_CAP);
      db.ad_budgets = [budget({ id: "b-2", status: "stopped" }), budget({ id: "b-3", tenant_id: OTHER })];
      expect(await goalOwnerDailyCap(T, NOW)).toBe(3);
      priorReviews(3, "goal_set");
      expect(await enqueueGoalOwnerRun({ tenant_id: T, reason: "goal_set", now: NOW })).toEqual({ enqueued: false, skipped: "daily_cap" });
      db.ad_budgets = [budget()];
      autopilotOn = false;
      expect(await goalOwnerDailyCap(T, NOW)).toBe(3);
    });
  });

  it("the daily check is outside the founder cap: 3 founder wakes cannot starve it, and it has its own daily key", async () => {
    db.autopilot_goals.push(goal(G1));
    db.agent_runs.push({ tenant_id: T, agent_slug: "cgo", cron_dedupe_key: `${T}:cgo-first-review`, payload: { stage: "own_goals", reason: "daily_check" }, enqueued_at: "2026-09-25T01:00:00.000Z" });
    for (let i = 0; i < 3; i++) {
      db.agent_runs.push({ tenant_id: T, agent_slug: "cgo", payload: { stage: "own_goals", reason: "goal_set" }, enqueued_at: "2026-09-26T0" + i + ":00:00.000Z" });
    }
    enqueueAgentRun.mockResolvedValueOnce({ run_id: "r-check" });
    const r = await enqueueGoalOwnerRun({
      tenant_id: T,
      reason: "daily_check",
      check: { kind: "alarm", reasons: ["cards_untouched"], alarm_keys: ["untouched:a1"] },
      now: NOW,
    });
    expect(r).toEqual({ enqueued: true, run_id: "r-check" });
    const arg = enqueueAgentRun.mock.calls[0][0];
    expect(arg.cron_dedupe_key).toBe(`${T}:cgo-check:2026-09-26`);
    expect(arg.payload).toMatchObject({ reason: "daily_check", note_kind: "alarm", alarm_keys: ["untouched:a1"] });
    expect(arg.payload.memory.cgo_goals.wake).toEqual({ kind: "alarm", reason: "daily_check", check_reasons: ["cards_untouched"], autopilot: true });
    expect(arg.payload.autopilot).toBe(true);
  });

  describe("the first daily check is on Zavi", () => {
    const check = { kind: "scheduled" as const, reasons: ["review_due" as const], alarm_keys: [] as string[] };

    it("a tenant's first daily check goes out under the first-review key, which the credit triggers do not charge", async () => {
      db.autopilot_goals.push(goal(G1));
      enqueueAgentRun.mockResolvedValueOnce({ run_id: "r-first" });
      expect(await enqueueGoalOwnerRun({ tenant_id: T, reason: "daily_check", check, now: NOW })).toEqual({ enqueued: true, run_id: "r-first" });
      expect(enqueueAgentRun.mock.calls[0][0].cron_dedupe_key).toBe(firstGoalReviewKey(T));
      expect(firstGoalReviewKey(T)).toBe(`${T}:cgo-first-review`);
    });

    it("the second daily check (a later day) is charged: it takes the normal day key", async () => {
      db.autopilot_goals.push(goal(G1));
      db.agent_runs.push({ tenant_id: T, agent_slug: "cgo", cron_dedupe_key: firstGoalReviewKey(T), payload: { stage: "own_goals", reason: "daily_check" }, enqueued_at: "2026-09-25T09:00:00.000Z" });
      enqueueAgentRun.mockResolvedValueOnce({ run_id: "r-second" });
      expect(await enqueueGoalOwnerRun({ tenant_id: T, reason: "daily_check", check, now: NOW })).toEqual({ enqueued: true, run_id: "r-second" });
      expect(enqueueAgentRun.mock.calls[0][0].cron_dedupe_key).toBe(`${T}:cgo-check:2026-09-26`);
    });

    it("a second check on the first check's own day is a duplicate, not a paid second review", async () => {
      db.autopilot_goals.push(goal(G1));
      db.agent_runs.push({ tenant_id: T, agent_slug: "cgo", cron_dedupe_key: firstGoalReviewKey(T), payload: { stage: "own_goals", reason: "daily_check" }, enqueued_at: "2026-09-26T01:00:00.000Z" });
      expect(await enqueueGoalOwnerRun({ tenant_id: T, reason: "daily_check", check, now: NOW })).toEqual({ enqueued: false, skipped: "duplicate" });
      expect(enqueueAgentRun).not.toHaveBeenCalled();
    });

    it("a first review that broke and was refunded (dispatch_error) is retried once, free, under the retry key", async () => {
      db.autopilot_goals.push(goal(G1));
      db.agent_runs.push({ tenant_id: T, agent_slug: "cgo", cron_dedupe_key: firstGoalReviewKey(T), status: "dispatch_error", payload: { stage: "own_goals", reason: "daily_check" }, enqueued_at: "2026-09-21T14:00:00.000Z" });
      enqueueAgentRun.mockResolvedValueOnce({ run_id: "r-retry" });
      expect(await enqueueGoalOwnerRun({ tenant_id: T, reason: "daily_check", check, now: NOW })).toEqual({ enqueued: true, run_id: "r-retry" });
      expect(enqueueAgentRun.mock.calls[0][0].cron_dedupe_key).toBe(firstGoalReviewRetryKey(T));
      expect(firstGoalReviewRetryKey(T)).toBe(`${T}:cgo-first-review:retry`);
    });

    it("a same-day replay never burns the retry or queues a paid third run", async () => {
      db.autopilot_goals.push(goal(G1));
      db.agent_runs.push({ tenant_id: T, agent_slug: "cgo", cron_dedupe_key: firstGoalReviewKey(T), status: "dispatch_error", payload: { stage: "own_goals", reason: "daily_check" }, enqueued_at: "2026-09-26T01:00:00.000Z" });
      expect(await enqueueGoalOwnerRun({ tenant_id: T, reason: "daily_check", check, now: NOW })).toEqual({ enqueued: false, skipped: "duplicate" });
      db.agent_runs = [{ tenant_id: T, agent_slug: "cgo", cron_dedupe_key: firstGoalReviewRetryKey(T), status: "dispatch_error", payload: { stage: "own_goals", reason: "daily_check" }, enqueued_at: "2026-09-26T02:00:00.000Z" }];
      expect(await enqueueGoalOwnerRun({ tenant_id: T, reason: "daily_check", check, now: NOW })).toEqual({ enqueued: false, skipped: "duplicate" });
      expect(enqueueAgentRun).not.toHaveBeenCalled();
    });

    it("a first review that ran to the end and failed (parse_failed) is not retried free; a dead retry falls to the paid day key", async () => {
      db.autopilot_goals.push(goal(G1));
      db.agent_runs.push({ tenant_id: T, agent_slug: "cgo", cron_dedupe_key: firstGoalReviewKey(T), status: "parse_failed", payload: { stage: "own_goals", reason: "daily_check" }, enqueued_at: "2026-09-21T14:00:00.000Z" });
      enqueueAgentRun.mockResolvedValueOnce({ run_id: "r-paid" });
      await enqueueGoalOwnerRun({ tenant_id: T, reason: "daily_check", check, now: NOW });
      expect(enqueueAgentRun.mock.calls[0][0].cron_dedupe_key).toBe(`${T}:cgo-check:2026-09-26`);
      db.agent_runs = [{ tenant_id: T, agent_slug: "cgo", cron_dedupe_key: firstGoalReviewRetryKey(T), status: "dispatch_error", payload: { stage: "own_goals", reason: "daily_check" }, enqueued_at: "2026-09-22T14:00:00.000Z" }];
      enqueueAgentRun.mockResolvedValueOnce({ run_id: "r-paid-2" });
      await enqueueGoalOwnerRun({ tenant_id: T, reason: "daily_check", check, now: NOW });
      expect(enqueueAgentRun.mock.calls[1][0].cron_dedupe_key).toBe(`${T}:cgo-check:2026-09-26`);
    });

    it("another tenant's first review does not make this one's first check paid", async () => {
      db.autopilot_goals.push(goal(G1));
      db.agent_runs.push({ tenant_id: OTHER, agent_slug: "cgo", cron_dedupe_key: firstGoalReviewKey(OTHER), payload: { stage: "own_goals", reason: "daily_check" }, enqueued_at: "2026-09-25T09:00:00.000Z" });
      enqueueAgentRun.mockResolvedValueOnce({ run_id: "r-first" });
      await enqueueGoalOwnerRun({ tenant_id: T, reason: "daily_check", check, now: NOW });
      expect(enqueueAgentRun.mock.calls[0][0].cron_dedupe_key).toBe(firstGoalReviewKey(T));
    });
  });

  it("a daily check run does not use up a founder wake", async () => {
    db.autopilot_goals.push(goal(G1));
    db.agent_runs.push({ tenant_id: T, agent_slug: "cgo", payload: { stage: "own_goals", reason: "daily_check" }, enqueued_at: "2026-09-26T01:00:00.000Z" });
    for (let i = 0; i < 2; i++) {
      db.agent_runs.push({ tenant_id: T, agent_slug: "cgo", payload: { stage: "own_goals", reason: "goal_set" }, enqueued_at: "2026-09-26T0" + (i + 2) + ":00:00.000Z" });
    }
    enqueueAgentRun.mockResolvedValueOnce({ run_id: "r-3" });
    const r = await enqueueGoalOwnerRun({ tenant_id: T, reason: "goal_set", now: NOW });
    expect(r).toEqual({ enqueued: true, run_id: "r-3" });
    expect(enqueueAgentRun.mock.calls[0][0].cron_dedupe_key).toBe(`${T}:cgo-own:2026-09-26:3`);
  });

  it("an anomaly wake needs Autopilot on OR a paid tier, keys once per incident, and never uses a founder slot", async () => {
    tenantTier = "free";
    db.autopilot_goals.push(goal(G1));
    const anomaly = {
      incident_id: "inc-1",
      family: "acquisition",
      metric_id: "sessions",
      label: "Sessions",
      date: "2026-09-25",
      direction: "down" as const,
      value: 412,
      typical: 1180,
      how_unusual: "far outside its normal range",
      supporting: [],
      contributors: [{ dimension: "source_medium", segment: "google / organic", share_pct: 78.4, confidence: "high" as const }],
    };
    expect(await enqueueGoalOwnerRun({ tenant_id: T, reason: "metric_anomaly", now: NOW })).toEqual({ enqueued: false, skipped: "duplicate" });
    autopilotOn = false;
    expect(await enqueueGoalOwnerRun({ tenant_id: T, reason: "metric_anomaly", anomaly, now: NOW })).toEqual({ enqueued: false, skipped: "autopilot_off" });
    tenantTier = "throw";
    expect(await enqueueGoalOwnerRun({ tenant_id: T, reason: "metric_anomaly", anomaly, now: NOW })).toEqual({ enqueued: false, skipped: "autopilot_off" });
    expect(enqueueAgentRun).not.toHaveBeenCalled();
    tenantTier = "starter";
    enqueueAgentRun.mockResolvedValueOnce({ run_id: "r-anom" });
    expect(await enqueueGoalOwnerRun({ tenant_id: T, reason: "metric_anomaly", anomaly, now: NOW })).toEqual({ enqueued: true, run_id: "r-anom" });
    const arg = enqueueAgentRun.mock.calls[0][0];
    expect(arg.cron_dedupe_key).toBe(`${T}:cgo-anomaly:inc-1`);
    expect(arg.payload).toMatchObject({ reason: "metric_anomaly", note_kind: "alarm", alarm_keys: ["metric_anomaly:inc-1"], autopilot: false });
    expect(arg.payload.memory.cgo_goals.wake.anomaly).toEqual(anomaly);
    tenantTier = "free";
    autopilotOn = true;
    enqueueAgentRun.mockResolvedValueOnce({ run_id: "r-anom-2" });
    expect(await enqueueGoalOwnerRun({ tenant_id: T, reason: "metric_anomaly", anomaly: { ...anomaly, incident_id: "inc-2" }, now: NOW })).toEqual({
      enqueued: true,
      run_id: "r-anom-2",
    });
    enqueueAgentRun.mockClear();
    autopilotOn = true;
    for (let i = 0; i < 3; i++) {
      db.agent_runs.push({ tenant_id: T, agent_slug: "cgo", payload: { stage: "own_goals", reason: "metric_anomaly" }, enqueued_at: `2026-09-26T0${i}:00:00.000Z` });
    }
    enqueueAgentRun.mockResolvedValueOnce({ run_id: "r-f" });
    expect(await enqueueGoalOwnerRun({ tenant_id: T, reason: "goal_set", now: NOW })).toEqual({ enqueued: true, run_id: "r-f" });
    expect(enqueueAgentRun.mock.calls[0][0].cron_dedupe_key).toBe(`${T}:cgo-own:2026-09-26:1`);
  });

  it("at most 3 incident wakes a day, however many families open", async () => {
    db.autopilot_goals.push(goal(G1));
    for (let i = 0; i < 3; i++) {
      db.agent_runs.push({ tenant_id: T, agent_slug: "cgo", payload: { stage: "own_goals", reason: "metric_anomaly" }, enqueued_at: `2026-09-26T0${i}:00:00.000Z` });
    }
    const anomaly = {
      incident_id: "inc-4",
      family: "revenue",
      metric_id: "net_revenue",
      label: "Net revenue",
      date: "2026-09-25",
      direction: "down" as const,
      value: 10,
      typical: 900,
      how_unusual: "far outside its normal range",
      supporting: [],
      contributors: [],
    };
    expect(await enqueueGoalOwnerRun({ tenant_id: T, reason: "metric_anomaly", anomaly, now: NOW })).toEqual({ enqueued: false, skipped: "daily_cap" });
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("enqueues an a2a own_goals run with the context and a tenant-scoped daily key", async () => {
    db.autopilot_goals.push(goal(G1));
    db.agent_runs.push({
      tenant_id: T,
      agent_slug: "seo",
      status: "success",
      payload: { dispatched_by: "cgo", goal_id: G1 },
      output_text: "Fixed titles on 4 pages",
      enqueued_at: "2026-09-26T09:00:00.000Z",
    });
    db.agent_runs.push({ tenant_id: T, agent_slug: "cgo", payload: { stage: "own_goals", reason: "goal_set" }, enqueued_at: "2026-09-25T23:00:00.000Z" });
    enqueueAgentRun.mockResolvedValueOnce({ run_id: "r-9" });
    const r = await enqueueGoalOwnerRun({ tenant_id: T, reason: "goal_set", goal_id: G1, now: NOW });
    expect(r).toEqual({ enqueued: true, run_id: "r-9" });
    const arg = enqueueAgentRun.mock.calls[0][0];
    expect(arg).toMatchObject({ agent_slug: "cgo", tenant_id: T, trigger: "a2a", cron_dedupe_key: `${T}:cgo-own:2026-09-26:1` });
    expect(arg.payload.stage).toBe("own_goals");
    expect(arg.payload.memory.cgo_goals.goals[0].goal_id).toBe(G1);
    expect(arg.payload.memory.cgo_goals.allowed_agents).not.toContain("operator");
    expect(arg.payload.memory.cgo_goals.allowed_agents).not.toContain("cgo");
    expect(arg.payload.memory.cgo_goals.finished_steps).toEqual([
      { goal_id: G1, agent: "seo", ordered_by: "cgo", status: "success", summary: "Fixed titles on 4 pages" },
    ]);
  });
});

describe("enqueueGoalOwnerRun: who closed a channel card reaches the review", () => {
  it("a card the system marked acted (cgo sending it back) is counted as system, never founder", async () => {
    db.autopilot_goals.push(goal(G1));
    db.channel_actions = [
      { tenant_id: T, id: "a-aw", channel_slug: "meta_ads", status: "acted", proposed_at: "2026-09-26T05:00:00.000Z", approved_by: null, approved_by_source: null },
      { tenant_id: T, id: "a-f", channel_slug: "meta_ads", status: "rejected", proposed_at: "2026-09-26T04:00:00.000Z", approved_by: null, approved_by_source: null },
    ];
    db.channel_action_events = [
      { tenant_id: T, action_id: "a-aw", actor_kind: "system", event: "acted", at: "2026-09-26T06:00:00.000Z" },
      { tenant_id: T, action_id: "a-f", actor_kind: "founder", event: "rejected", at: "2026-09-26T05:30:00.000Z" },
    ];
    enqueueAgentRun.mockResolvedValueOnce({ run_id: "r-attr" });
    await enqueueGoalOwnerRun({ tenant_id: T, reason: "goal_set", goal_id: G1, now: NOW });
    const view = enqueueAgentRun.mock.calls[0][0].payload.memory.cgo_goals.channels.find((c: { channel_slug: string }) => c.channel_slug === "meta_ads");
    expect(view.closed_by).toEqual({ system: 1, founder: 1 });
    expect(view.founder_rejected).toBe(true);
  });
});

describe("questions, facts, replies and quiet", () => {
  const on = { kind: "scheduled" as const, alarm_keys: [], autopilot: true };
  const Q1 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

  it("a question with a pause default is stored with its deadline and told to the founder with the default", async () => {
    db.autopilot_goals.push(goal(G1));
    const { emitDecision } = emitter();
    const res = await applyGoalMoves(
      T,
      "run-1",
      review([], { note: { need: [], questions: [{ topic: "reddit", ask: "Reddit gets no clicks. Keep it?", if_no_answer: { action: "pause_channel", channel_slug: "reddit_organic" }, by_days: 3 }] } }),
      { emitDecision, resolveRepo: noRepo, now: NOW, meta: { ...on, never_approved: ["reddit_organic"] } },
    );
    expect(db.cgo_questions).toEqual([
      expect.objectContaining({
        tenant_id: T,
        topic_key: "channel:reddit-organic",
        ask: "Keep it?",
        why: "Reddit gets no clicks.",
        default_action: { kind: "pause_channel", channel_slug: "reddit_organic", why: "Reddit gets no clicks. Keep it?" },
        expires_at: "2026-09-29T12:00:00.000Z",
      }),
    ]);
    expect(db.cgo_notes[0].need).toEqual(["Reddit gets no clicks. Keep it? If I don't hear back by Sep 29, I'll pause Reddit."]);
    expect(db.cgo_notes[0].questions).toEqual(["Reddit gets no clicks. Keep it? If I don't hear back by Sep 29, I'll pause Reddit."]);
    expect(res.note_visible).toBe(true);
  });

  it("S4: a TRIED channel is never paused on silence: the question is kept, its pause default dropped", async () => {
    db.autopilot_goals.push(goal(G1));
    const { emitDecision } = emitter();
    await applyGoalMoves(
      T,
      "run-1",
      review([], { note: { need: [], questions: [{ topic: "reddit", ask: "Reddit gets no clicks. Keep it?", if_no_answer: { action: "pause_channel", channel_slug: "reddit_organic" }, by_days: 3 }] } }),
      { emitDecision, resolveRepo: noRepo, now: NOW, meta: on },
    );
    expect(db.cgo_questions).toEqual([expect.objectContaining({ topic_key: "channel:reddit-organic", default_action: null })]);
    expect(db.cgo_notes[0].need).toEqual(["Reddit gets no clicks. Keep it?"]);
  });

  it("S4: a review's pause of a tried organic channel needs its own per-item numbers, and never rests on a quiet founder", async () => {
    db.autopilot_goals.push(goal(G1));
    rpcResult.pause_channel_by_cgo = "ok";
    const pause = (why: string) => review([], { channel_changes: [{ channel_slug: "reddit_organic", action: "pause", why }] });
    await applyGoalMoves(T, "run-1", pause("No sign-ups this week."), { emitDecision: emitter().emitDecision, resolveRepo: noRepo, now: NOW, meta: on, evidence: { paid: [], organic: [], own_moves: [] } });
    expect(rpcCalls.filter((c) => c.fn === "pause_channel_by_cgo")).toHaveLength(0);
    expect(db.cgo_notes[0].refused).toEqual([expect.stringContaining("evidence_missing")]);
    expect(db.cgo_questions).toEqual([expect.objectContaining({ topic_key: "channel:reddit-organic", default_action: null })]);
    db.cgo_questions = [];
    await applyGoalMoves(T, "run-2", pause("The founder has not opened anything in 9 days."), { emitDecision: emitter().emitDecision, resolveRepo: noRepo, now: NOW, meta: on, evidence: perItem("reddit_organic") });
    expect(rpcCalls.filter((c) => c.fn === "pause_channel_by_cgo")).toHaveLength(0);
    expect(db.cgo_notes[1].refused).toEqual([expect.stringContaining("founder_silence_not_grounds")]);
    expect(db.cgo_questions).toEqual([]);
    await applyGoalMoves(T, "run-3", pause("Five posts, under 40 impressions each."), { emitDecision: emitter().emitDecision, resolveRepo: noRepo, now: NOW, meta: on, evidence: perItem("reddit_organic") });
    expect(rpcCalls.filter((c) => c.fn === "pause_channel_by_cgo")).toHaveLength(1);
  });

  it("S4: a cut order the evidence says cannot be judged yet is refused; a cut it allows starts", async () => {
    db.autopilot_goals.push(goal(G1));
    db.ad_budgets = [{ id: "b-1", tenant_id: T, status: "active", monthly_usd: 1000, spent_usd: 0, held_usd: 0, daily_limit_usd: null }];
    const set = (name: string, label: string) => ({ id: `id-${name}`, name, goal: null, learning: null, days_since_edit: 20, spend_7d_usd: 140, conversions_7d: 0, tracking: "ok" as const, label });
    const evidence = {
      paid: [
        {
          channel_slug: "meta_ads",
          status: "read" as const,
          campaigns: [
            { id: "c1", name: "All States - Awareness", objective: "OUTCOME_AWARENESS", label: "not set up to optimise for conversions, so judged on its own objective", ad_sets: [set("Reach", "not set up to optimise for conversions, so judged on its own objective")] },
            { id: "c2", name: "Hosts - Phoenix", objective: "OUTCOME_LEADS", label: "too early to judge (learning)", ad_sets: [set("Phoenix - Leads", "too early to judge (learning)")] },
            { id: "c3", name: "Hosts - SF", objective: "OUTCOME_LEADS", label: "judged on cost per conversion", ad_sets: [set("SF - Leads", "judged on cost per conversion")] },
          ],
        },
      ],
      organic: [],
      own_moves: [],
    } as unknown as NonNullable<Parameters<typeof applyGoalMoves>[3]["evidence"]>;
    const move = (intent: string) => review([{ goal_id: G1, moves: [{ target_agent_slug: "meta_ads", intent, why: "" }] }]);
    const autoRun = vi.fn(async () => true);
    for (const intent of ['Pause "All States - Awareness": zero bookings in 7 days.', 'Cut "Phoenix - Leads" in half.']) {
      const e = emitter();
      await applyGoalMoves(T, `run-${intent.length}`, move(intent), { emitDecision: e.emitDecision, resolveRepo: noRepo, now: NOW, autoRun, meta: on, evidence });
      expect(e.emitted).toHaveLength(0);
      expect(db.cgo_notes.at(-1)?.refused).toEqual([expect.stringMatching(/^Cut for meta_ads .*not judged yet/)]);
    }
    const ok = emitter();
    await applyGoalMoves(T, "run-ok", move('Lower "SF - Leads" to $20/day: $140 and no leads, CPA past $70.'), { emitDecision: ok.emitDecision, resolveRepo: noRepo, now: NOW, autoRun, meta: on, evidence });
    expect(ok.emitted).toHaveLength(1);
  });

  it("never asks an open topic again, and never a topic closed in the last two weeks", async () => {
    db.autopilot_goals.push(goal(G1));
    db.cgo_questions.push(
      { id: "q-open", tenant_id: T, topic_key: "reddit", ask: "old", status: "open", asked_at: "2026-09-25T00:00:00Z", expires_at: "2026-09-28T00:00:00Z" },
      { id: "q-done", tenant_id: T, topic_key: "budget", ask: "old", status: "answered", asked_at: "2026-09-20T00:00:00Z", answered_at: "2026-09-21T00:00:00Z", expires_at: "2026-09-23T00:00:00Z" },
    );
    const { emitDecision } = emitter();
    const res = await applyGoalMoves(
      T,
      "run-1",
      review([], { note: { need: [], questions: [{ topic: "Reddit", ask: "Keep Reddit?" }, { topic: "budget", ask: "Raise the budget?" }] } }),
      { emitDecision, resolveRepo: noRepo, now: NOW, meta: on },
    );
    expect(db.cgo_questions).toHaveLength(2);
    expect(db.cgo_notes[0].need).toEqual([]);
    expect(res.note_visible).toBe(false);
  });

  it("a default cgo may not take is dropped (the question stays); with Autopilot off no question has a default", async () => {
    db.autopilot_goals.push(goal(G1));
    const { emitDecision } = emitter();
    await applyGoalMoves(
      T,
      "run-1",
      review([], {
        note: {
          need: [],
          questions: [
            { topic: "cut", ask: "Cut the goal to 10?", if_no_answer: { action: "goal_change", goal_id: G1, target_value: 10 } },
            { topic: "made-up", ask: "Pause the moon?", if_no_answer: { action: "pause_channel", channel_slug: "moon" } },
          ],
        },
      }),
      { emitDecision, resolveRepo: noRepo, now: NOW, meta: on },
    );
    expect(db.cgo_questions.map((q) => [q.topic_key, q.default_action])).toEqual([
      [`goal:${G1}`, null],
      ["made-up", null],
    ]);
    expect(db.cgo_notes[0].refused).toHaveLength(2);

    db.cgo_questions.length = 0;
    await applyGoalMoves(
      T,
      "run-2",
      review([], { note: { need: [], questions: [{ topic: "reddit", ask: "Keep Reddit?", if_no_answer: { action: "pause_channel", channel_slug: "reddit_organic" } }] } }),
      { emitDecision, resolveRepo: noRepo, now: NOW, meta: { ...on, autopilot: false } },
    );
    expect(db.cgo_questions[0]).toMatchObject({ topic_key: "channel:reddit-organic", default_action: null, default_line: null });
  });

  it("a goal is never changed on silence: a raised target and a reworded goal both drop the default", async () => {
    db.autopilot_goals.push(goal(G1));
    const { emitDecision } = emitter();
    await applyGoalMoves(
      T,
      "run-1",
      review([], { note: { need: [], questions: [{ topic: "stretch", ask: "You are ahead. Raise it to 30?", if_no_answer: { action: "goal_change", goal_id: G1, target_value: 30 } }] } }),
      { emitDecision, resolveRepo: noRepo, now: NOW, meta: on, reviewedRevs: new Map([[G1, goalRev(goal(G1) as GoalRow)]]) },
    );
    expect(db.cgo_questions[0].default_action).toBeNull();
    db.cgo_questions.length = 0;
    await applyGoalMoves(
      T,
      "run-2",
      review([], { note: { need: [], questions: [{ topic: "name", ask: "Call it 'weekly signups'?", if_no_answer: { action: "goal_change", goal_id: G1, objective: "Weekly signups: 20" } }] } }),
      { emitDecision, resolveRepo: noRepo, now: NOW, meta: on, reviewedRevs: new Map([[G1, goalRev(goal(G1) as GoalRow)]]) },
    );
    expect(db.cgo_questions[0].default_action).toBeNull();
  });

  it("an eased goal becomes a question, never a write", async () => {
    db.autopilot_goals.push(goal(G1));
    const { emitDecision } = emitter();
    const res = await applyGoalMoves(T, "run-1", review([], { goal_changes: [{ goal_id: G1, target_value: 12, why: "Only 6 so far." }] }), {
      emitDecision,
      resolveRepo: noRepo,
      now: NOW,
      meta: on,
    });
    expect(res.goals_changed).toBe(0);
    expect(db.autopilot_goals[0].target_value).toBe(20);
    expect(db.cgo_questions).toEqual([expect.objectContaining({ topic_key: `goal:${G1}`, default_action: null })]);
    expect((db.cgo_notes[0].need as string[])[0]).toContain('Should I make "Get 20 signups" easier (target 20 to 12)?');
  });

  it("the note's facts are the server's (from the review payload), never the model's saw lines", async () => {
    db.autopilot_goals.push(goal(G1));
    const { emitDecision } = emitter();
    await applyGoalMoves(T, "run-1", review([], { note: { saw: ["I paused Meta and it worked."], need: [], questions: [] } }), {
      emitDecision,
      resolveRepo: noRepo,
      now: NOW,
      meta: { ...on, saw: ["Get 20 signups: 6 of 20 weekly signups, 35 days left."] },
    });
    expect(db.cgo_notes[0].saw).toEqual(["Get 20 signups: 6 of 20 weekly signups, 35 days left."]);
  });

  it("a founder reply marks only this tenant's open questions answered", async () => {
    db.autopilot_goals.push(goal(G1));
    db.cgo_questions.push(
      { id: Q1, tenant_id: T, topic_key: "reddit", ask: "Keep Reddit?", status: "open", asked_at: "2026-09-25T00:00:00Z", expires_at: "2026-09-28T00:00:00Z" },
      { id: GX, tenant_id: OTHER, topic_key: "x", ask: "x", status: "open", asked_at: "2026-09-25T00:00:00Z", expires_at: "2026-09-28T00:00:00Z" },
    );
    const { emitDecision } = emitter();
    await applyGoalMoves(
      T,
      "run-r",
      review([], { answered: [{ question_id: Q1, answer: "Keep it, give it two weeks." }, { question_id: GX, answer: "y" }] }),
      { emitDecision, resolveRepo: noRepo, now: NOW, meta: { ...on, kind: "founder", reply_via: "slack" } },
    );
    expect(db.cgo_questions[0]).toMatchObject({ status: "answered", answer: "Keep it, give it two weeks.", answered_via: "slack", resolved_run_id: "run-r" });
    expect(db.cgo_questions[1].status).toBe("open");

    db.cgo_questions[1].tenant_id = T;
    await applyGoalMoves(T, "run-x", review([], { answered: [{ question_id: GX, answer: "y" }] }), { emitDecision, resolveRepo: noRepo, now: NOW, meta: on });
    expect(db.cgo_questions[1].status).toBe("open");
  });

  it("a second empty check-in in a row pushes the next one out two weeks; one with news does not", async () => {
    db.autopilot_goals.push(goal(G1));
    const { emitDecision } = emitter();
    await applyGoalMoves(T, "run-1", review([], { next_review_in_days: 3 }), { emitDecision, resolveRepo: noRepo, now: NOW, meta: { ...on, prev_idle: true } });
    const gap = (n: Row) => (Date.parse(String(n.next_review_at)) - NOW.getTime()) / 86_400_000;
    expect(gap(db.cgo_notes[0])).toBe(14);
    expect(db.cgo_notes[0].next_review_why).toBe("Nothing new in the last two check-ins.");

    await applyGoalMoves(T, "run-2", review([], { next_review_in_days: 3 }), { emitDecision, resolveRepo: noRepo, now: NOW, meta: { ...on, prev_idle: false } });
    expect(gap(db.cgo_notes[1])).toBe(5);

    await applyGoalMoves(T, "run-3", review([], { next_review_in_days: 3, note: { need: [], questions: [{ topic: "new", ask: "New question?" }] } }), {
      emitDecision,
      resolveRepo: noRepo,
      now: NOW,
      meta: { ...on, prev_idle: true },
    });
    expect(gap(db.cgo_notes[2])).toBe(5);
  });

  it("a founder reply review counts toward the daily cap, and needs an active goal, like any founder wake", async () => {
    db.autopilot_goals.push(goal(G1));
    for (let i = 0; i < 3; i++) db.agent_runs.push({ tenant_id: T, agent_slug: "cgo", enqueued_at: "2026-09-26T08:00:00Z", payload: { stage: "own_goals", reason: "goal_set" } });
    const reply = { via: "slack" as const, text: "Keep it.", reply_run_id: "reply-9" };
    expect(await enqueueGoalOwnerRun({ tenant_id: T, reason: "founder_reply", founder_reply: reply, now: NOW })).toEqual({ enqueued: false, skipped: "daily_cap" });
    db.autopilot_goals.length = 0;
    expect(await enqueueGoalOwnerRun({ tenant_id: T, reason: "founder_reply", founder_reply: reply, now: NOW })).toEqual({ enqueued: false, skipped: "no_active_goals" });
  });

  it("a founder's own reply to a note (keyed by its reply run) gets its review even when the day's cap is used up", async () => {
    db.autopilot_goals.push(goal(G1));
    for (let i = 0; i < 3; i++) db.agent_runs.push({ tenant_id: T, agent_slug: "cgo", enqueued_at: "2026-09-26T08:00:00Z", payload: { stage: "own_goals", reason: "goal_set" } });
    const reply = { via: "slack" as const, text: "Go ahead.", reply_run_id: "22222222-2222-4222-8222-222222222222" };
    enqueueAgentRun.mockResolvedValue({ run_id: "r-reply" });
    expect(await enqueueGoalOwnerRun({ tenant_id: T, reason: "founder_reply", founder_reply: reply, now: NOW })).toMatchObject({ enqueued: true });
    expect(await enqueueGoalOwnerRun({ tenant_id: T, reason: "goal_set", now: NOW })).toEqual({ enqueued: false, skipped: "daily_cap" });
  });

  it("a Growth chat ask (key chat:<run>) keeps the daily cap, needs Autopilot, and carries cgo's reading apart", async () => {
    db.autopilot_goals.push(goal(G1));
    const ask = { via: "chat" as const, text: "Rerun the content.", reply_run_id: "chat:22222222-2222-4222-8222-222222222222", cgo_reading: "Rerun content." };
    expect(await chatAskAdmission(T, NOW)).toBeNull();
    enqueueAgentRun.mockResolvedValue({ run_id: "r-ask" });
    expect(await enqueueGoalOwnerRun({ tenant_id: T, reason: "founder_reply", founder_reply: ask, require_autopilot: true, now: NOW })).toEqual({ enqueued: true, run_id: "r-ask" });
    const call = enqueueAgentRun.mock.calls[0][0];
    expect(call.cron_dedupe_key).toBe(`${T}:cgo-own:2026-09-26:1`);
    expect(call.payload.memory.cgo_goals.founder_reply).toEqual({ via: "chat", text: "Rerun the content.", cgo_reading: "Rerun content." });
    expect(reviewMetaFromPayload(call.payload)).toMatchObject({ reply_via: "chat" });
    expect(reviewMetaFromPayload(call.payload).reply_text).toBeUndefined();
    autopilotOn = false;
    expect(await chatAskAdmission(T, NOW)).toBe("autopilot_off");
    expect(await enqueueGoalOwnerRun({ tenant_id: T, reason: "founder_reply", founder_reply: ask, require_autopilot: true, now: NOW })).toEqual({ enqueued: false, skipped: "autopilot_off" });
    autopilotOn = true;
    for (let i = 0; i < 3; i++) db.agent_runs.push({ tenant_id: T, agent_slug: "cgo", enqueued_at: "2026-09-26T08:00:00Z", payload: { stage: "own_goals", reason: "goal_set" } });
    expect(await chatAskAdmission(T, NOW)).toBe("daily_cap");
    expect(await enqueueGoalOwnerRun({ tenant_id: T, reason: "founder_reply", founder_reply: ask, require_autopilot: true, now: NOW })).toEqual({ enqueued: false, skipped: "daily_cap" });
    db.autopilot_goals.length = 0;
    expect(await chatAskAdmission(T, NOW)).toBe("no_active_goals");
  });

  it("a topic answered after its deadline (before the sweep) is still inside the no-reask window", async () => {
    db.autopilot_goals.push(goal(G1));
    db.cgo_questions.push({ id: "q-after", tenant_id: T, topic_key: "seo", ask: "old", status: "answered", asked_at: "2026-09-02T12:00:00Z", answered_at: "2026-09-13T13:00:00Z", expires_at: "2026-09-09T12:00:00Z" });
    const { emitDecision } = emitter();
    await applyGoalMoves(T, "run-1", review([], { note: { need: [], questions: [{ topic: "seo", ask: "Keep SEO?" }] } }), { emitDecision, resolveRepo: noRepo, now: NOW, meta: on });
    expect(db.cgo_questions).toHaveLength(1);
  });

  it("a topic answered near its deadline is still inside the 14-day no-reask window", async () => {
    db.autopilot_goals.push(goal(G1));
    db.cgo_questions.push({ id: "q-late", tenant_id: T, topic_key: "reddit", ask: "old", status: "answered", asked_at: "2026-09-11T12:00:00Z", answered_at: "2026-09-18T11:00:00Z", expires_at: "2026-09-18T12:00:00Z" });
    const { emitDecision } = emitter();
    await applyGoalMoves(T, "run-1", review([], { note: { need: [], questions: [{ topic: "reddit", ask: "Keep Reddit?" }] } }), { emitDecision, resolveRepo: noRepo, now: NOW, meta: on });
    expect(db.cgo_questions).toHaveLength(1);
  });

  it("a yes whose change could not be tried is applied by the review that claims it, once", async () => {
    db.autopilot_goals.push(goal(G1));
    const onYes = { kind: "goal_change", goal_id: G1, goal_rev: goalRev(goal(G1) as GoalRow), change: { target_value: 30 }, why: "Ahead." };
    db.cgo_questions.push({ id: "q-yes", tenant_id: T, topic_key: `goal:${G1}`, ask: "Should I raise it?", status: "answered", answer: "yes", on_yes: onYes, applied_line: null, asked_run_id: "run-ask", resolved_run_id: null });
    const { emitDecision } = emitter();
    const meta = { kind: "founder" as const, alarm_keys: [], autopilot: true, reply_via: "web" as const, answered_ids: ["q-yes"] };
    await applyGoalMoves(T, "run-2", review([]), { emitDecision, resolveRepo: noRepo, now: NOW, meta });
    expect(db.autopilot_goals[0]).toMatchObject({ target_value: 30 });
    expect(db.cgo_questions[0]).toMatchObject({ resolved_run_id: "run-2" });
    expect(db.cgo_questions[0].applied_line).toContain("Get 20 signups");
  });

  it("a founder reply review runs with Autopilot off, once per reply", async () => {
    autopilotOn = false;
    db.autopilot_goals.push(goal(G1));
    enqueueAgentRun.mockResolvedValue({ run_id: "r-reply" });
    const reply = { via: "email" as const, text: "Keep Reddit.", reply_run_id: "reply-1" };
    const r = await enqueueGoalOwnerRun({ tenant_id: T, reason: "founder_reply", founder_reply: reply, now: NOW });
    expect(r).toEqual({ enqueued: true, run_id: "r-reply" });
    const call = enqueueAgentRun.mock.calls[0][0];
    expect(call.cron_dedupe_key).toBe(`${T}:cgo-reply:reply-1`);
    expect(call.payload).toMatchObject({ reason: "founder_reply", autopilot: false, founder_reply: { via: "email", reply_run_id: "reply-1" } });
    expect(call.payload.memory.cgo_goals.founder_reply).toEqual({ via: "email", text: "Keep Reddit." });
    expect(await enqueueGoalOwnerRun({ tenant_id: T, reason: "founder_reply", now: NOW })).toEqual({ enqueued: false, skipped: "duplicate" });
  });
});

describe("applyApprovedGoalChange (the founder said yes)", () => {
  const def = (change: Record<string, unknown>, rev = goalRev(goal(G1) as GoalRow)) =>
    ({ kind: "goal_change" as const, goal_id: G1, goal_rev: rev, change, why: "You are ahead." });

  it("applies the change the founder approved, raised or eased, with undo under the run that asked", async () => {
    db.autopilot_goals.push(goal(G1));
    const line = await applyApprovedGoalChange(T, "run-ask", def({ target_value: 30 }), NOW);
    expect(line).toContain('Goal "Get 20 signups"');
    expect(db.autopilot_goals[0]).toMatchObject({ target_value: 30 });
    expect((db.autopilot_goals[0].cgo_undo as Row).run_id).toBe("run-ask");
  });

  it("never when the founder edited the goal since the question was asked, and never out of bounds", async () => {
    db.autopilot_goals.push(goal(G1));
    expect(await applyApprovedGoalChange(T, "run-ask", def({ target_value: 30 }, "an-older-rev"), NOW)).toBeNull();
    expect(await applyApprovedGoalChange(T, "run-ask", def({ target_value: -5 }), NOW)).toBeNull();
    expect(db.autopilot_goals[0].target_value).toBe(20);
  });
});

describe("parseGoalMoves is lenient where the model writes freely", () => {
  it("a count rule with a long definition keeps the review; a malformed rule is dropped, not the review", () => {
    const def = "renters whose first trip ever reached a paid, completed state, counted on the trip end date, excluding cancelled, refunded and test bookings, and excluding hosts renting their own cars to themselves";
    expect(def.length).toBeGreaterThan(160);
    const r = parseGoalMoves(
      `<goal_moves>${JSON.stringify({
        note: { questions: [{ topic: "t", ask: "Keep it?" }] },
        goal_count_rules: [
          { goal_id: G1, definition: def, dialect: "mongodb", collection: "trips", pipeline: [{ $count: "n" }] },
          { goal_id: "not-a-uuid", definition: "x", dialect: "sql", query: "select 1" },
          { goal_id: G1, definition: "y".repeat(401), dialect: "sql", query: "select 1" },
        ],
        next_review_in_days: 3,
      })}</goal_moves>`,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.goal_count_rules?.map((g) => g.definition)).toEqual([def]);
    expect(r.value.note?.questions).toHaveLength(1);
    expect(r.value.next_review_in_days).toBe(3);
  });

  it("a review with no goals key parses", () => {
    const r = parseGoalMoves(`<goal_moves>{"note": {"questions": [{"topic": "reddit", "ask": "Keep Reddit?"}]}, "next_review_in_days": 4}</goal_moves>`);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.goals).toEqual([]);
  });

  it("an over-long question, why or next-review reason is cut, not rejected", () => {
    const long = "x".repeat(900);
    const r = parseGoalMoves(
      `<goal_moves>${JSON.stringify({
        note: { questions: [{ topic: "t", ask: long }] },
        channel_changes: [{ channel_slug: "seo", action: "pause", why: long }],
        goal_changes: [{ goal_id: G1, target_value: 30, why: long }],
        next_review_why: long,
      })}</goal_moves>`,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.note?.questions[0].ask).toHaveLength(400);
    expect(r.value.channel_changes[0].why).toHaveLength(300);
    expect(r.value.goal_changes[0].why).toHaveLength(300);
    expect(r.value.next_review_why).toHaveLength(300);
  });
});

describe("iteration 1: on-pace backoff, subject topics, never-approved channels", () => {
  const on = { kind: "scheduled" as const, alarm_keys: [], autopilot: true };

  it("two empty check-ins back off only while every goal is on pace", async () => {
    db.autopilot_goals.push(goal(G1));
    const { emitDecision } = emitter();
    const gap = (n: Row) => (Date.parse(String(n.next_review_at)) - NOW.getTime()) / 86_400_000;
    await applyGoalMoves(T, "run-1", review([], { next_review_in_days: 3 }), { emitDecision, resolveRepo: noRepo, now: NOW, meta: { ...on, prev_idle: true, behind_pace: true } });
    expect(gap(db.cgo_notes[0])).toBe(3);
    await applyGoalMoves(T, "run-2", review([], { next_review_in_days: 3 }), { emitDecision, resolveRepo: noRepo, now: NOW, meta: { ...on, prev_idle: true, behind_pace: false } });
    expect(gap(db.cgo_notes[1])).toBe(14);
  });

  it("a question about a known subject is keyed on it, so a reworded repeat is not asked", async () => {
    db.autopilot_goals.push(goal(G1));
    const { emitDecision } = emitter();
    await applyGoalMoves(T, "run-1", review([], { note: { need: [], questions: [{ topic: "budget", about: "meta_ads", ask: "You rejected the Meta cards. Budget or creative?" }] } }), {
      emitDecision,
      resolveRepo: noRepo,
      now: NOW,
      meta: on,
    });
    await applyGoalMoves(T, "run-2", review([], { note: { need: [], questions: [{ topic: "paid", about: "meta_ads", ask: "Why do you keep declining the Meta ads?" }] } }), {
      emitDecision,
      resolveRepo: noRepo,
      now: NOW,
      meta: on,
    });
    expect(db.cgo_questions.map((q) => q.topic_key)).toEqual(["channel:meta-ads"]);
    expect(db.cgo_notes[1].need).toEqual([]);
  });

  it("a never-approved channel is not paused: it becomes a question with pause as the default", async () => {
    db.autopilot_goals.push(goal(G1));
    rpcResult.pause_channel_by_cgo = "ok";
    const { emitDecision } = emitter();
    const res = await applyGoalMoves(T, "run-1", review([], { channel_changes: [{ channel_slug: "reddit_organic", action: "pause", why: "0 visits." }] }), {
      emitDecision,
      resolveRepo: noRepo,
      now: NOW,
      meta: { ...on, never_approved: ["reddit_organic"] },
    });
    expect(res.channels_paused).toBe(0);
    expect(rpcCalls.filter((c) => c.fn === "pause_channel_by_cgo")).toHaveLength(0);
    expect(db.cgo_questions).toEqual([
      expect.objectContaining({ topic_key: "channel:reddit-organic", default_action: expect.objectContaining({ kind: "pause_channel", channel_slug: "reddit_organic" }) }),
    ]);
    expect(String((db.cgo_notes[0].need as string[])[0])).toContain("hasn't really been tried");
  });

  it("R6/R1: an ad channel gets no silence default, from the model or from the never-approved rule", async () => {
    db.autopilot_goals.push(goal(G1));
    const { emitDecision } = emitter();
    await applyGoalMoves(
      T,
      "run-1",
      review([], {
        channel_changes: [{ channel_slug: "google_ads", action: "pause", why: "0 clicks." }],
        note: { need: [], questions: [{ topic: "meta", ask: "Meta gets nothing. Keep it?", if_no_answer: { action: "pause_channel", channel_slug: "meta_ads" }, by_days: 3 }] },
      }),
      { emitDecision, resolveRepo: noRepo, now: NOW, meta: { ...on, never_approved: ["google_ads"] } },
    );
    expect(rpcCalls.filter((c) => c.fn === "pause_channel_by_cgo")).toHaveLength(0);
    expect(db.cgo_questions.length).toBeGreaterThan(0);
    for (const q of db.cgo_questions) expect(q.default_action).toBeNull();
  });

  it("reviewMetaFromPayload reads pace and never-approved channels from the review's context", () => {
    const meta = reviewMetaFromPayload({
      memory: {
        cgo_goals: {
          goals: [{ behind_pace: false }, { behind_pace: true }],
          channels: [
            { channel_slug: "reddit_organic", last_14_days: { proposed: 5, acted: 0, rejected: 0 } },
            { channel_slug: "meta_ads", last_14_days: { proposed: 5, acted: 0, rejected: 4 } },
            { channel_slug: "seo", last_14_days: { proposed: 5, acted: 2, rejected: 0 } },
            { channel_slug: "x_organic", last_14_days: { proposed: 0, acted: 0, rejected: 0 } },
          ],
        },
      },
    });
    expect(meta).toMatchObject({ behind_pace: true, never_approved: ["reddit_organic"] });
  });
});

describe("iteration 2: pace line, no pause default on a rejected channel", () => {
  const on = { kind: "scheduled" as const, alarm_keys: [], autopilot: true };

  it("projectedAtDue: the rate since the goal was set, carried to the due date; null before 3 days or without a start", () => {
    const g = { ...(goal(G1) as unknown as GoalRow), created_at: "2026-09-16T08:00:00Z", current_value: 20, baseline_value: 0, due_date: "2026-10-16" };
    expect(projectedAtDue(g, "2026-09-26")).toBe(62);
    expect(statusLineFor(g, "2026-09-26")).toBe("20 of 20 weekly signups, 20 days left, on pace for about 62 by Oct 16");
    expect(projectedAtDue({ ...g, created_at: "2026-09-25T00:00:00Z" }, "2026-09-26")).toBeNull();
    expect(projectedAtDue({ ...g, created_at: null }, "2026-09-26")).toBeNull();
    expect(projectedAtDue({ ...g, due_date: null }, "2026-09-26")).toBeNull();
  });

  it("a pause default on a channel the founder is rejecting is dropped: rejecting is a no, not an off switch", async () => {
    db.autopilot_goals.push(goal(G1));
    const { emitDecision } = emitter();
    await applyGoalMoves(
      T,
      "run-1",
      review([], { note: { need: [], questions: [{ topic: "meta", ask: "Budget or creative?", if_no_answer: { action: "pause_channel", channel_slug: "meta_ads" } }] } }),
      { emitDecision, resolveRepo: noRepo, now: NOW, meta: { ...on, rejected_channels: ["meta_ads"] } },
    );
    expect(db.cgo_questions[0]).toMatchObject({ topic_key: "channel:meta-ads", default_action: null });
    expect(db.cgo_notes[0].refused).toHaveLength(1);
  });
});

describe("iteration 3: no repeated move within the week", () => {
  it("the same agent on the same goal is not started again within 7 days; another agent still can be", async () => {
    db.autopilot_goals.push(goal(G1));
    db.decisions.push({
      id: "old-card",
      tenant_id: T,
      agent_run_id: "run-0",
      decision_class: "cgo.dispatch-specialist",
      status: "acted",
      emitted_at: "2026-09-10T12:00:00.000Z",
      approved_at: "2026-09-23T12:00:00.000Z",
      body: { goal_id: G1, target_agent_slug: "content-design" },
    });
    const { emitted, emitDecision } = emitter();
    await applyGoalMoves(
      T,
      "run-1",
      review([{ goal_id: G1, moves: [{ target_agent_slug: "content-design", intent: "5 more posts", why: "" }, { target_agent_slug: "research", intent: "find what converts", why: "" }] }]),
      { emitDecision, resolveRepo: noRepo, now: NOW, meta: { kind: "scheduled", alarm_keys: [], autopilot: false } as never },
    );
    expect(emitted).toHaveLength(0);
    const { emitted: e2, emitDecision: ed2 } = emitter();
    await applyGoalMoves(
      T,
      "run-2",
      review([{ goal_id: G1, moves: [{ target_agent_slug: "content-design", intent: "5 more posts", why: "" }, { target_agent_slug: "research", intent: "find what converts", why: "" }] }]),
      { emitDecision: ed2, resolveRepo: noRepo, now: NOW, autoRun: async () => false },
    );
    expect(e2.map((e) => e.body.target_agent_slug)).toEqual(["research"]);
    expect((db.cgo_notes.at(-1)?.refused as string[]).some((l) => l.includes("already ran on this problem this week"))).toBe(true);
  });
});

describe("iteration 4: the founder's target is theirs, no pause promise on their channel", () => {
  const on = { kind: "scheduled" as const, alarm_keys: [], autopilot: true };
  it("a founder-added channel gets its question but no pause default (cgo could not keep that promise)", async () => {
    db.autopilot_goals.push(goal(G1));
    const { emitDecision } = emitter();
    await applyGoalMoves(T, "run-1", review([], { channel_changes: [{ channel_slug: "reddit_organic", action: "pause", why: "0 visits." }] }), {
      emitDecision,
      resolveRepo: noRepo,
      now: NOW,
      meta: { ...on, never_approved: ["reddit_organic"], founder_channels: ["reddit_organic"] },
    });
    expect(db.cgo_questions[0]).toMatchObject({ topic_key: "channel:reddit-organic", default_action: null, default_line: null });
    expect(String((db.cgo_notes[0].need as string[])[0])).not.toContain("I'll pause");
  });
  it("a raised target is asked, not written", async () => {
    db.autopilot_goals.push(goal(G1));
    const { emitDecision } = emitter();
    const res = await applyGoalMoves(T, "run-1", review([], { goal_changes: [{ goal_id: G1, target_value: 55, why: "Ahead of pace." }] }), {
      emitDecision,
      resolveRepo: noRepo,
      now: NOW,
      meta: on,
    });
    expect(res.goals_changed).toBe(0);
    expect(db.autopilot_goals[0].target_value).toBe(20);
    expect(String((db.cgo_notes[0].need as string[])[0])).toContain('Should I raise the bar on "Get 20 signups" (target 20 to 55)?');
  });
});

describe("cutAtWord (note lines end at a whole word, not mid-word)", () => {
  it("keeps short text unchanged", async () => {
    const { cutAtWord } = await import("../goal-owner");
    expect(cutAtWord("  short line  ", 50)).toBe("short line");
  });
  it("cuts at the last whole word and ends with an ellipsis", async () => {
    const { cutAtWord } = await import("../goal-owner");
    const s = "Upcar Sales Search is the worst: $294.48 for 1 conversion, while Upcar.ai Search spent less";
    const out = cutAtWord(s, 70);
    expect(out.length).toBeLessThanOrEqual(70);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/Upc…$/);
    expect(s.startsWith(out.slice(0, -1))).toBe(true);
  });
  it("never leaves trailing punctuation before the ellipsis", async () => {
    const { cutAtWord } = await import("../goal-owner");
    expect(cutAtWord("alpha beta, gamma delta epsilon zeta", 13)).toBe("alpha beta…");
  });
});

describe("channel cards (the open-advice invariant)", () => {
  const TURO = "120259468814150059";
  const acts = { kind: "scheduled" as const, alarm_keys: [], autopilot: true };
  const budget = { id: "b-1", tenant_id: T, status: "active", monthly_usd: 1000, spent_usd: 0, held_usd: 0, daily_limit_usd: null };
  const card = (id: string, over: Row = {}): Row => ({
    id,
    tenant_id: T,
    run_id: "meta-run-old",
    channel_slug: "meta_ads",
    title: `Card ${id}`,
    body: { step: { body: `Step of ${id}` } },
    exec_class: null,
    exec_payload: null,
    exec_status: null,
    status: "pending",
    ...over,
  });
  const shown = (...ids: Array<[string, string]>) => new Map(ids.map(([id, ch]) => [id, { channel_slug: ch, title: `Card ${id}` }]));
  const cards = (list: NonNullable<GoalMoves["channel_cards"]>, extra: Partial<GoalMoves> = {}) => review([], { channel_cards: list, ...extra });

  beforeEach(() => {
    db.autopilot_goals.push(goal(G1));
    db.ad_budgets = [budget];
    db.channel_actions = [];
    rpcResult = { set_channel_action: { ok: true } };
  });

  it("a card the gate holds sends the review note on the ads clock, once: the gate no longer emails it on its own", async () => {
    db.channel_actions.push(
      card("c-held", { channel_slug: "google_ads", exec_class: "google_ads.update_campaign_budget", exec_payload: { campaign_id: "c1", daily_budget_usd: 25 }, title: "Halve a search campaign" }),
    );
    const approve = vi.fn(async (_t: string, _id: string, opts?: { onHeld?: (r: string[]) => void }) => {
      opts?.onHeld?.(["objective_not_conversions"]);
      return false;
    });
    const clock = { ...acts, kind: "alarm" as const, ads_clock: true };
    const deps = { emitDecision: emitter().emitDecision, resolveRepo: noRepo, now: NOW, shownCards: shown(["c-held", "google_ads"]), approveChannelAction: approve };
    const res = await applyGoalMoves(T, "run-1", cards([{ action_id: "c-held", decision: "approve", why: "" }]), { ...deps, meta: clock });
    const need = db.cgo_notes.at(-1)!.need as string[];
    expect(need).toEqual([expect.stringMatching(/^Left for you: Halve a search campaign/)]);
    expect(res).toMatchObject({ note_visible: true, note_notify: true });
    db.channel_actions.find((r) => r.id === "c-held")!.status = "pending";
    const res2 = await applyGoalMoves(T, "run-2", cards([{ action_id: "c-held", decision: "approve", why: "" }]), { ...deps, meta: { ...clock, last_need: need } });
    expect(res2).toMatchObject({ note_notify: false });
    const failed = vi.fn(async () => false);
    db.channel_actions.push(card("c-fail", { channel_slug: "google_ads", exec_class: "google_ads.update_campaign_budget", exec_payload: { campaign_id: "c2", daily_budget_usd: 30 }, title: "Lower another campaign" }));
    const res3 = await applyGoalMoves(T, "run-3", cards([{ action_id: "c-fail", decision: "approve", why: "" }]), { ...deps, shownCards: shown(["c-fail", "google_ads"]), approveChannelAction: failed, meta: { ...clock, last_need: need } });
    expect(res3).toMatchObject({ note_notify: false });
  });

  it("a review deciding more than 20 cards is applied: the first 20 are decided, the rest stay open", async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `bake-${i + 1}`);
    db.channel_actions.push(...ids.map((id) => card(id)));
    const decisions = [
      { action_id: "not-shown", decision: "leave", why: "Ours to fix." },
      ...ids.map((action_id) => ({ action_id, decision: "reject", why: "Same post ran last week." })),
    ];
    const parsed = parseGoalMoves(`<goal_moves>${JSON.stringify({ goals: [{ goal_id: G1, status_line: "12 of 40 orders", moves: [] }], channel_cards: decisions })}</goal_moves>`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.channel_cards).toHaveLength(26);
    const notesBefore = db.cgo_notes.length;
    await applyGoalMoves(T, "run-25", parsed.value, {
      emitDecision: emitter().emitDecision,
      resolveRepo: noRepo,
      now: NOW,
      meta: acts,
      shownCards: shown(...ids.map((id) => [id, "meta_ads"] as [string, string])),
    });
    const rejected = rpcCalls.filter((c) => c.fn === "set_channel_action").map((c) => (c.args as { p_action_id: string }).p_action_id);
    expect(rejected).toEqual(ids.slice(0, 20));
    expect(db.cgo_notes.length).toBe(notesBefore + 1);
  });

  it("a bad card item is dropped on its own, never the review; the 20 are fixed on the list as written", () => {
    const shownIds = new Map(Array.from({ length: 22 }, (_, i) => [`k${i + 1}`, { channel_slug: "meta_ads", title: "x" }]));
    const list = Array.from({ length: 22 }, (_, i) => ({ action_id: `k${i + 1}`, decision: "reject", why: "No orders." }));
    const parsed = parseGoalMoves(
      `<goal_moves>${JSON.stringify({ goals: [], channel_cards: [...list, { action_id: "k23", decision: "leave" }, { action_id: "k24", decision: "approv" }] })}</goal_moves>`,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.channel_cards).toHaveLength(22);
    const ids = cardsToApply([{ action_id: "nope" }, ...list, { action_id: "k1" }], shownIds);
    expect([...ids]).toEqual(list.slice(0, 20).map((c) => c.action_id));
    expect(ids.has("k21")).toBe(false);
  });

  it("an invalid item still holds its place: a later card never moves into the 20", async () => {
    const ids = Array.from({ length: 21 }, (_, i) => `slot-${i + 1}`);
    db.channel_actions.push(...ids.map((id) => card(id)));
    const parsed = parseGoalMoves(
      `<goal_moves>${JSON.stringify({ goals: [], channel_cards: [{ action_id: "slot-1", decision: "leave" }, ...ids.slice(1).map((action_id) => ({ action_id, decision: "reject", why: "No orders." }))] })}</goal_moves>`,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    await applyGoalMoves(T, "run-slots", parsed.value, {
      emitDecision: emitter().emitDecision,
      resolveRepo: noRepo,
      now: NOW,
      meta: acts,
      shownCards: shown(...ids.map((id) => [id, "meta_ads"] as [string, string])),
    });
    const decided = rpcCalls.filter((c) => c.fn === "set_channel_action").map((c) => (c.args as { p_action_id: string }).p_action_id);
    expect(decided).toEqual(ids.slice(1, 20));
    expect(decided).not.toContain("slot-21");
  });

  it("rejects as cgo (not the founder), approves an executable card, leaves the rest; rejects go first", async () => {
    db.channel_actions.push(
      card("c-app", { exec_class: "meta_ads.set_status", exec_payload: { object_id: "111111111111", status: "PAUSED", name: "SF - Leads" }, title: "Pause ad set 111111111111" }),
      card("c-rej"),
      card("c-leave"),
    );
    const log: string[] = [];
    const approve = vi.fn(async (_t: string, id: string) => {
      log.push(`approve:${id}`);
      return true;
    });
    const { emitDecision } = emitter();
    await applyGoalMoves(
      T,
      "run-1",
      cards([
        { action_id: "c-app", decision: "approve", why: "" },
        { action_id: "c-rej", decision: "reject", why: "Tested last month, no bookings." },
        { action_id: "c-leave", decision: "leave", why: "Rebuilding it is a bigger call than a pause. Your call." },
      ]),
      { emitDecision, resolveRepo: noRepo, now: NOW, meta: acts, shownCards: shown(["c-app", "meta_ads"], ["c-rej", "meta_ads"], ["c-leave", "meta_ads"]), approveChannelAction: approve },
    );
    const rej = rpcCalls.find((c) => c.fn === "set_channel_action")!;
    expect(rej.args).toMatchObject({
      p_tenant_id: T,
      p_action_id: "c-rej",
      p_status: "rejected",
      p_note: "Tested last month, no bookings.",
      p_actor_user_id: null,
      p_source: "cgo",
      p_event_key: "cgo-reject:run-1:c-rej",
    });
    expect(approve.mock.calls).toEqual([[T, "c-app", expect.objectContaining({ onHeld: expect.any(Function) })]]);
    expect(rpcCalls.filter((c) => c.fn === "set_channel_action")).toHaveLength(1);
    const note = db.cgo_notes[0];
    expect(note.changed).toEqual([expect.stringMatching(/^Rejected the .* card "Card c-rej"/), expect.stringMatching(/^Approved the .* card "Pause ad set/)]);
    expect(note.refused).toEqual(expect.arrayContaining([expect.stringMatching(/^Left the .* card "Card c-leave" for the founder/)]));
    expect(note.need).toEqual(["Left for you: Card c-leave, because Rebuilding it is a bigger call than a pause. Your call."]);
    expect(note.questions).toEqual([]);
    expect(log).toEqual(["approve:c-app"]);
  });

  it("never rejects a card the founder approved: an approved card waiting on the founder's fix stays open, with why", async () => {
    db.channel_actions.push(
      card("c-mine", { exec_class: "meta_ads.update_ad_set_budget", exec_payload: { ad_set_id: "111111111111", daily_budget_usd: 272, expected_current_daily_budget_usd: 200 }, exec_status: "failed", exec_result: { error: "cap_refuse: ad_budget_over_month", bucket: "needs_founder", fix: "ad_budget" }, title: "Raise SF - Leads to $272" }),
      card("c-cgo", { exec_class: "meta_ads.update_ad_set_budget", exec_payload: { ad_set_id: "222222222222", daily_budget_usd: 60, expected_current_daily_budget_usd: 50 }, exec_status: "failed", exec_result: { error: "cap_refuse: ad_budget_over_month", bucket: "needs_founder", fix: "ad_budget" }, title: "Raise LA - Leads to $60" }),
    );
    db.channel_action_events = [
      { tenant_id: T, action_id: "c-mine", event: "approved", actor_kind: "founder", actor_user_id: "u-founder" },
      { tenant_id: T, action_id: "c-cgo", event: "approved", actor_kind: "system", actor_user_id: "u-founder" },
    ];
    await applyGoalMoves(
      T,
      "run-1",
      cards([
        { action_id: "c-mine", decision: "reject", why: "Over budget this month." },
        { action_id: "c-cgo", decision: "reject", why: "Over budget this month." },
      ]),
      { emitDecision: emitter().emitDecision, resolveRepo: noRepo, now: NOW, meta: acts, shownCards: shown(["c-mine", "meta_ads"], ["c-cgo", "meta_ads"]) },
    );
    const rejects = rpcCalls.filter((c) => c.fn === "set_channel_action");
    expect(rejects.map((c) => c.args.p_action_id)).toEqual(["c-cgo"]);
    const note = db.cgo_notes[0];
    expect(note.need).toEqual([
      "Left for you: Raise ad set 111111111111 from $200 to $272 a day, because you approved this; it is waiting on you to raise your ad budget on the Growth page, or approve a smaller change.",
    ]);
    expect(note.refused).toEqual(expect.arrayContaining([expect.stringMatching(/^Reject the .* card "Raise ad set 111111111111 from \$200 to \$272 a day": the founder approved it, so it stays open/)]));
  });

  it("a card the founder approved by replying never reaches the unattended path, and a refused yes drops cgo's headline", async () => {
    db.channel_actions.push(card("c-yes", { exec_class: "meta_ads.set_status", exec_payload: { object_id: "111111111111", status: "PAUSED", name: "SF - Leads" }, title: "Pause ad set 111111111111" }), card("c-other", { exec_class: "meta_ads.set_status", exec_payload: { object_id: "222222222222", status: "PAUSED", name: "LA - Leads" }, title: "Pause ad set 222222222222" }), card("c-held", { exec_class: "meta_ads.set_status", exec_payload: { object_id: "333333333333", status: "PAUSED", name: "NY - Leads" }, title: "Pause ad set 333333333333" }));
    const approve = vi.fn(async () => true);
    const settle = vi.fn(async () => undefined);
    const founderReplyApprovals = vi.fn(async () => ({
      handled: new Set(["c-yes"]),
      items: [{ section: "needs_you" as const, text: "Pause ad set SF", reason: "It needs more monthly ad budget than is left", action_id: "c-yes", channel_slug: "meta_ads", budget_from_usd: 1000, budget_to_usd: 1200 }],
      changed: [],
      ad_changed: false,
      unfulfilled: true,
      withhold: (id: string) => id === "c-held",
      settleAndAnswer: settle,
    }));
    const replyPayload = { reason: "founder_reply", founder_reply: { via: "slack", reply_run_id: "r-1" } };
    await applyGoalMoves(
      T,
      "run-1",
      cards(
        [
          { action_id: "c-yes", decision: "approve", why: "" },
          { action_id: "c-other", decision: "approve", why: "" },
          { action_id: "c-held", decision: "approve", why: "" },
        ],
        { note: { headline: "You said yes, so I approved the raise and it is live." } } as Partial<GoalMoves>,
      ),
      { emitDecision: emitter().emitDecision, resolveRepo: noRepo, now: NOW, meta: acts, shownCards: shown(["c-yes", "meta_ads"], ["c-other", "meta_ads"], ["c-held", "meta_ads"]), approveChannelAction: approve, replyPayload, founderReplyApprovals },
    );
    expect(founderReplyApprovals).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: T, payload: replyPayload }));
    expect(approve.mock.calls.map((c) => (c as unknown[])[1])).toEqual(["c-other"]);
    expect(settle).toHaveBeenCalledTimes(1);
    const note = db.cgo_notes[0];
    expect(note.headline).not.toMatch(/approved the raise/);
    expect((note.items as Array<{ action_id?: string; budget_to_usd?: number }>).find((i) => i.action_id === "c-yes")).toMatchObject({ budget_to_usd: 1200 });
  });

  it("R7: a card the server held says why in plain words; a card left again is not told twice", async () => {
    db.channel_actions.push(
      card("c-cut", { exec_class: "meta_ads.update_ad_set_budget", exec_payload: { ad_set_id: "222222222222", daily_budget_usd: 10, expected_current_daily_budget_usd: 20, name: "Phoenix - Leads" }, title: "Cut Phoenix to $10/day" }),
      card("c-post", { channel_slug: "x_organic", title: "X post: hosts earn more" }),
    );
    const approve = vi.fn(async (_t: string, _id: string, o?: { onHeld?: (r: string[]) => void }) => {
      o?.onHeld?.(["learning_lock"]);
      return false;
    });
    const decide = cards([
      { action_id: "c-cut", decision: "approve", why: "$60 and no leads." },
      { action_id: "c-post", decision: "approve", why: "Good post." },
    ]);
    const deps = { emitDecision: emitter().emitDecision, resolveRepo: noRepo, now: NOW, meta: acts, shownCards: shown(["c-cut", "meta_ads"], ["c-post", "x_organic"]), approveChannelAction: approve };
    await applyGoalMoves(T, "run-1", decide, deps);
    expect(db.cgo_notes[0].need).toEqual([
      "Left for you: Cut “Phoenix - Leads” (ad set 222222222222) from $20 to $10 a day, because it was changed recently and is still settling.",
      "Left for you: X post: hosts earn more, because only you approve what goes out on this channel.",
    ]);
    await applyGoalMoves(T, "run-2", decide, { ...deps, meta: { ...acts, last_need: db.cgo_notes[0].need as string[] } });
    expect(db.cgo_notes[1].need).toEqual([]);
  });

  it("a card id the review was not shown, or another tenant's card, is ignored", async () => {
    db.channel_actions.push(card("x-other", { tenant_id: OTHER }), card("c-mine"));
    const approve = vi.fn(async () => true);
    const { emitDecision, emitted } = emitter();
    await applyGoalMoves(
      T,
      "run-1",
      cards([
        { action_id: "x-other", decision: "reject", why: "" },
        { action_id: "c-mine", decision: "reject", why: "" },
        { action_id: "x-never", decision: "approve", why: "" },
      ]),
      { emitDecision, resolveRepo: noRepo, now: NOW, meta: acts, shownCards: shown(["x-other", "meta_ads"]), approveChannelAction: approve },
    );
    expect(rpcCalls.filter((c) => c.fn === "set_channel_action")).toHaveLength(0);
    expect(approve).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(0);
    expect(db.channel_actions.map((r) => r.status)).toEqual(["pending", "pending"]);
    expect(db.cgo_notes[0].refused).toEqual(expect.arrayContaining([expect.stringContaining("x-other: it is no longer open")]));
  });

  it("approving an executable card another open card contradicts: not approved, and the open card is the ask (no question, cgo-log 2026-10-23)", async () => {
    db.channel_actions.push(
      card("c-pause", { run_id: "meta-run-new", exec_class: "meta_ads.set_status", exec_payload: { object_id: TURO, name: "40% to Turo", status: "PAUSED" }, title: "Pause “40% to Turo”" }),
      card("c-rebuild", { title: "Rebuild 40% to Turo as a conversion campaign" }),
    );
    const approve = vi.fn(async () => true);
    await applyGoalMoves(T, "run-1", cards([{ action_id: "c-pause", decision: "approve", why: "" }]), {
      emitDecision: emitter().emitDecision,
      resolveRepo: noRepo,
      now: NOW,
      meta: acts,
      shownCards: shown(["c-pause", "meta_ads"], ["c-rebuild", "meta_ads"]),
      approveChannelAction: approve,
    });
    expect(approve).not.toHaveBeenCalled();
    expect(db.cgo_questions).toHaveLength(0);
    expect(db.cgo_notes[0].refused).toEqual(expect.arrayContaining([expect.stringContaining("Rebuild 40% to Turo as a conversion campaign")]));
  });

  it("approving a non-executable card sends it back to the channel as its order and marks it acted", async () => {
    db.channel_actions.push(card("c-build", { title: "Rebuild 40% to Turo as a conversion campaign" }));
    const { emitDecision, emitted } = emitter();
    const autoRun = vi.fn(async () => true);
    await applyGoalMoves(T, "run-1", cards([{ action_id: "c-build", decision: "approve", why: "Bookings need a conversion objective." }]), {
      emitDecision,
      resolveRepo: noRepo,
      now: NOW,
      autoRun,
      meta: acts,
      shownCards: shown(["c-build", "meta_ads"]),
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].cls).toBe("cgo.dispatch-specialist");
    expect(emitted[0].body).toMatchObject({ target_agent_slug: "meta_ads", dispatched_by: "cgo", goal_id: G1, goal_rev: goalRev(goal(G1) as never) });
    expect(String(emitted[0].body.intent)).toContain('"Rebuild 40% to Turo as a conversion campaign"');
    expect(autoRun).toHaveBeenCalledWith(T, "d-1");
    expect(rpcCalls.find((c) => c.fn === "set_channel_action")!.args).toMatchObject({ p_action_id: "c-build", p_status: "acted", p_source: "cgo", p_actor_user_id: null });
    expect(db.cgo_notes[0].changed).toEqual([expect.stringMatching(/^Sent .* its card "Rebuild 40% to Turo/)]);
  });

  describe("a non-executable cut card is judged on its evidence before it is sent back (S4)", () => {
    const AWARE = "Upcar - All States - Awareness";
    const CONV = "Upcar - SF - Bookings";
    const adSet = (id: string, name: string, label: string, over: Record<string, unknown> = {}) => ({
      id, name, goal: "REACH", learning: false, days_since_edit: 30, spend_7d_usd: 140, conversions_7d: 0, tracking: "ok" as const, label, ...over,
    });
    const evidence = {
      paid: [
        {
          channel_slug: "meta_ads",
          status: "read" as const,
          campaigns: [
            { id: "c-aw", name: AWARE, objective: "OUTCOME_AWARENESS", label: "not set up to optimise for conversions, so judged on its own objective", ad_sets: [adSet("s-aw", "All States", "not set up to optimise for conversions, so judged on its own objective")] },
            {
              id: "c-cv", name: CONV, objective: "OUTCOME_SALES", label: "judged on cost per conversion",
              ad_sets: [adSet("s-cv", "SF", "judged on cost per conversion", { goal: "OFFSITE_CONVERSIONS", conversions_7d: 0, spend_7d_usd: 300 })],
            },
          ],
        },
      ],
      organic: [],
      own_moves: [],
    };
    const run = async (title: string, ev: unknown) => {
      db.channel_actions.push(card("c-cut", { title, body: { step: { body: "No purchases in 7 days." } } }));
      const { emitDecision, emitted } = emitter();
      const autoRun = vi.fn(async () => true);
      await applyGoalMoves(T, "run-1", cards([{ action_id: "c-cut", decision: "approve", why: "Zero purchases on $140." }]), {
        emitDecision, resolveRepo: noRepo, now: NOW, autoRun, meta: acts, shownCards: shown(["c-cut", "meta_ads"]), evidence: ev as never,
      });
      return { emitted, autoRun };
    };

    it("an awareness campaign with zero conversions: left for the founder with the reason, not sent back, not acted", async () => {
      const { emitted, autoRun } = await run(`Approve pause — ${AWARE}`, evidence);
      expect(emitted).toHaveLength(0);
      expect(autoRun).not.toHaveBeenCalled();
      expect(rpcCalls.filter((c) => c.fn === "set_channel_action")).toHaveLength(0);
      expect(db.channel_actions[0].status).toBe("pending");
      expect(db.cgo_notes[0].need).toEqual([`Left for you: Approve pause — ${AWARE}, because it is built for reach, so zero conversions says nothing.`]);
      expect(db.cgo_notes[0].changed).toEqual([]);
    });

    it("a conversion campaign past learning, with evidence: sent back as before", async () => {
      const { emitted, autoRun } = await run(`Pause ${CONV}`, evidence);
      expect(emitted).toHaveLength(1);
      expect(emitted[0].body).toMatchObject({ target_agent_slug: "meta_ads", origin_action_id: "c-cut" });
      expect(autoRun).toHaveBeenCalledTimes(1);
      expect(rpcCalls.find((c) => c.fn === "set_channel_action")!.args).toMatchObject({ p_action_id: "c-cut", p_status: "acted" });
    });

    it("a card that is not a cut (lower CPA with new creative) is sent back even with no evidence", async () => {
      const { emitted } = await run("Create new creative to lower CPA", null);
      expect(emitted).toHaveLength(1);
    });

    it("no evidence: left (fail closed)", async () => {
      const { emitted } = await run(`Pause ${CONV}`, null);
      expect(emitted).toHaveLength(0);
      expect(rpcCalls.filter((c) => c.fn === "set_channel_action")).toHaveLength(0);
      expect(db.cgo_notes[0].need).toEqual([`Left for you: Pause ${CONV}, because I could not read its numbers.`]);
    });
  });

  it("a non-ad card, or any card with no ad budget, waits for the founder", async () => {
    db.channel_actions.push(card("c-post", { channel_slug: "reddit_organic" }), card("c-ad"));
    db.ad_budgets = [];
    const approve = vi.fn(async () => true);
    const { emitDecision, emitted } = emitter();
    await applyGoalMoves(
      T,
      "run-1",
      cards([
        { action_id: "c-post", decision: "approve", why: "" },
        { action_id: "c-ad", decision: "reject", why: "" },
      ]),
      { emitDecision, resolveRepo: noRepo, now: NOW, meta: acts, shownCards: shown(["c-post", "reddit_organic"], ["c-ad", "meta_ads"]), approveChannelAction: approve },
    );
    expect(approve).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(0);
    expect(rpcCalls.filter((c) => c.fn === "set_channel_action")).toHaveLength(0);
    expect(db.cgo_notes[0].refused).toEqual(expect.arrayContaining([expect.stringContaining("waits for the founder")]));
  });

  it("decision 1: a pause of an ad channel with an undecided shown card is refused, not paused and not asked (cgo-log 2026-10-23)", async () => {
    db.channel_actions.push(card("c-open"));
    db.tenant_channels = [{ tenant_id: T, channel_slug: "meta_ads", plan_selected: true }];
    await applyGoalMoves(T, "run-1", review([], { channel_changes: [{ channel_slug: "meta_ads", action: "pause", why: "No bookings." }] }), {
      emitDecision: emitter().emitDecision,
      resolveRepo: noRepo,
      now: NOW,
      meta: acts,
      shownCards: shown(["c-open", "meta_ads"]),
    });
    expect(rpcCalls.some((c) => c.fn === "pause_channel_by_cgo")).toBe(false);
    expect(db.cgo_questions).toHaveLength(0);
    expect(db.cgo_notes[0].refused).toEqual(expect.arrayContaining([expect.stringContaining("still wait")]));
  });

  it("decision 1: a move that names an open card's object starts nothing and asks nothing: the card is the ask", async () => {
    db.channel_actions.push(card("c-x", { title: "Rebuild “40% to Turo”" }));
    const { emitDecision, emitted } = emitter();
    await applyGoalMoves(T, "run-1", review([{ goal_id: G1, moves: [{ target_agent_slug: "meta_ads", intent: "pause 40% to Turo now", why: "" }] }]), {
      emitDecision,
      resolveRepo: noRepo,
      now: NOW,
      autoRun: vi.fn(async () => true),
      meta: acts,
    });
    expect(emitted).toHaveLength(0);
    expect(db.cgo_questions).toHaveLength(0);
  });

  it("advice only: card decisions become would-lines and nothing is touched", async () => {
    db.channel_actions.push(card("c-rej"));
    await applyGoalMoves(T, "run-1", cards([{ action_id: "c-rej", decision: "reject", why: "stale" }]), {
      emitDecision: emitter().emitDecision,
      resolveRepo: noRepo,
      now: NOW,
      meta: { ...acts, autopilot: false },
      shownCards: shown(["c-rej", "meta_ads"]),
    });
    expect(rpcCalls.filter((c) => c.fn === "set_channel_action")).toHaveLength(0);
    expect(db.cgo_notes[0].would_change).toEqual([expect.stringMatching(/^Reject the .* card "Card c-rej"\. stale$/)]);
  });

  it("the shown set comes from the run payload, never the model; the block parses", () => {
    const payload = { memory: { cgo_goals: { channels: [{ channel_slug: "meta_ads", open_cards: [{ action_id: "a-1", title: "T" }] }, { channel_slug: "seo" }] } } };
    expect([...shownCardsFromPayload(payload)!]).toEqual([["a-1", { channel_slug: "meta_ads", title: "T" }]]);
    expect(shownCardsFromPayload({ memory: { cgo_goals: { channels: [{ channel_slug: "seo" }] } } })).toBeUndefined();
    const parsed = parseGoalMoves(`<goal_moves>{"channel_cards":[{"action_id":"a-1","decision":"reject","why":"no"}]}</goal_moves>`);
    expect(parsed.ok && parsed.value.channel_cards).toEqual([{ action_id: "a-1", decision: "reject", why: "no" }]);
  });
});

describe("planNote shows every question stored", () => {
  it("five questions stored, five shown (a hidden question could still act on silence)", async () => {
    const { planNote } = await import("../goal-owner");
    const note = planNote({
      meta: { kind: "scheduled", alarm_keys: [], autopilot: true },
      moves: { goals: [], goal_changes: [], channel_changes: [] } as unknown as GoalMoves,
      saw: [],
      changedLines: [],
      wouldLines: [],
      needLines: ["a?", "b?", "c?", "d?", "e?"],
      refused: [],
      now: NOW,
      reviewDays: 7,
    });
    expect(note.need).toEqual(["a?", "b?", "c?", "d?", "e?"]);
  });
});

describe("#3347 review: only the founder's rejections count", () => {
  it("a channel only cgo rejected cards on is not a 'rejected channel'; one the founder rejected is", () => {
    const meta = reviewMetaFromPayload({
      memory: {
        cgo_goals: {
          channels: [
            { channel_slug: "meta_ads", founder_rejected: false, last_14_days: { proposed: 5, acted: 0, rejected: 3 } },
            { channel_slug: "seo", founder_rejected: true, last_14_days: { proposed: 5, acted: 1, rejected: 1 } },
          ],
        },
      },
    });
    expect(meta.rejected_channels).toEqual(["seo"]);
  });
});

describe("move tags (PLAN-cgo-benchmark-v2)", () => {
  const block = (move: Record<string, unknown>) =>
    `<goal_moves>${JSON.stringify({ goals: [{ goal_id: "11111111-1111-4111-8111-111111111111", moves: [{ target_agent_slug: "research", intent: "find why visitors leave", ...move }] }] })}</goal_moves>`;

  it("keeps a listed problem and the metric", () => {
    const r = parseGoalMoves(block({ problem: "Conversion", moves_metric: "weekly_signups" }));
    expect(r.ok && r.value.goals[0].moves[0]).toMatchObject({ problem: "conversion", moves_metric: "weekly_signups" });
  });

  it("an unknown or malformed tag never drops the review", () => {
    for (const bad of [{ problem: "vibes" }, { problem: 7 }, { moves_metric: 12 }, {}]) {
      const r = parseGoalMoves(block(bad));
      expect(r.ok).toBe(true);
      const m = r.ok ? r.value.goals[0].moves[0] : null;
      expect(normalizeProblem(m?.problem)).toBe("unspecified");
      expect(m?.moves_metric).toBeUndefined();
    }
  });
});

describe("who decided cgo's own cards (attribution)", () => {
  it("decided_cards says cgo, founder or unknown; finished steps are cgo's orders", () => {
    expect(decisionActor({ approved_by: "owner", approved_by_source: "cgo" })).toBe("cgo");
    expect(decisionActor({ approved_by: "u1", approved_by_source: null })).toBe("founder");
    expect(decisionActor({ rejected_by: "u1" })).toBe("founder");
    expect(decisionActor({ approved_by: "u1", approved_by_source: "staff" })).toBe("unknown");
    expect(decisionActor({})).toBe("unknown");
    const ctx = composeGoalOwnerContext({
      today: "2026-09-28",
      goals: [],
      channels: [],
      founder: { last_active_at: null, days_since_active: null, approved_14d: 0, rejected_14d: 0 },
      lastNote: null,
      cards: [
        { body: { goal_id: "g", target_agent_slug: "meta_ads", intent: "Build your own open card" }, status: "acted", approved_by: "owner", approved_by_source: "cgo" },
        { body: { goal_id: "g", target_agent_slug: "seo", intent: "Fix titles" }, status: "approved", approved_by: "u1" },
        { body: { goal_id: "g", target_agent_slug: "x_organic", intent: "Posts" }, status: "expired" },
      ],
      steps: [{ agent_slug: "meta_ads", status: "success", payload: { goal_id: "g" }, output_text: "done" }],
      agents: [],
      wake: { kind: "scheduled", reason: "scheduled", autopilot: true } as never,
    });
    expect(ctx.decided_cards.map((c) => c.by)).toEqual(["cgo", "founder", "unknown"]);
    expect(ctx.finished_steps[0].ordered_by).toBe("cgo");
  });
});

describe("R10: the founder closing the card a channel's rejection cited releases the order", () => {
  const ORDER = "Draft three posts on how hosts earn more.";
  const setup = (actor: "founder" | "system") => {
    db.autopilot_goals.push(goal(G1));
    db.agent_runs.push({
      tenant_id: T,
      agent_slug: "linkedin_organic",
      status: "success",
      enqueued_at: "2026-09-25T09:00:00.000Z",
      finished_at: "2026-09-25T10:00:00.000Z",
      payload: { dispatched_by: "cgo", goal_id: G1, goal_rev: goalRev(goal(G1) as never), intent: ORDER, cgo_brief: { goal: { current_value: goal(G1).current_value } } },
      parsed: { cgo_reply: { status: "rejected", reason: 'My open card "Host earnings series: week 1" covers this; decide it first.', summary: "Did not write them." } },
    });
    db.channel_actions = [{ tenant_id: T, id: "c-series", channel_slug: "linkedin_organic", title: "Host earnings series: week 1", status: "acted" }];
    db.channel_action_events = [{ tenant_id: T, action_id: "c-series", actor_kind: actor, event: "acted", at: "2026-09-25T15:00:00.000Z" }];
  };
  const go = async () => {
    const { emitted, emitDecision } = emitter();
    const raw = review([{ goal_id: G1, status_line: "x", moves: [{ target_agent_slug: "linkedin_organic", intent: ORDER, why: "Hosts find us on LinkedIn." }] }]);
    await applyGoalMoves(T, "run-1", raw, { emitDecision, resolveRepo: noRepo, now: NOW, autoRun: vi.fn(async () => true), meta: { kind: "scheduled", alarm_keys: [], autopilot: true } });
    return emitted;
  };
  it("closed by the founder after the rejection: the order goes again", async () => {
    setup("founder");
    expect((await go()).map((e) => e.body.target_agent_slug)).toEqual(["linkedin_organic"]);
  });
  it("closed by the system: still held", async () => {
    setup("system");
    expect(await go()).toHaveLength(0);
    expect(db.cgo_notes[0].refused).toEqual(expect.arrayContaining([expect.stringContaining("rejected this order")]));
  });
});

describe("syncGoalWork", () => {
  const card = (id: string, goal_id: string, goal_rev: string, tenant_id = T): Row => ({
    id,
    tenant_id,
    decision_class: "cgo.dispatch-specialist",
    status: "proposed",
    body: { goal_id, goal_rev, target_agent_slug: "seo", intent: "x" },
  });

  it("rewrites the status line from the saved goal and leaves every open card as it is; the next review withdraws the stale one", async () => {
    const g = goal(G1, { target_value: 40, cgo_status_line: "6 of 20 weekly signups" } as Partial<GoalRow>);
    db.autopilot_goals.push(g);
    const current = goalRev(g as unknown as GoalRow);
    db.decisions.push(card("old", G1, "stale-rev"), card("fresh", G1, current), card("other", G1, "stale-rev", OTHER));
    await syncGoalWork(T, G1, NOW);
    expect(db.autopilot_goals[0].cgo_status_line).toBe(statusLineFor(g as unknown as GoalRow, "2026-09-26"));
    expect(db.autopilot_goals[0].cgo_status_line).toContain("6 of 40");
    expect(db.decisions.map((d) => [d.id, d.status])).toEqual([
      ["old", "proposed"],
      ["fresh", "proposed"],
      ["other", "proposed"],
    ]);
    await applyGoalMoves(T, "run-2", review([]), { emitDecision: emitter().emitDecision, resolveRepo: noRepo, now: NOW });
    expect(db.decisions.map((d) => [d.id, d.status])).toEqual([
      ["old", "expired"],
      ["fresh", "proposed"],
      ["other", "proposed"],
    ]);
  });

  it("the wake a goal edit sends withdraws no card either", async () => {
    const g = goal(G1, { target_value: 40 } as Partial<GoalRow>);
    db.autopilot_goals.push(g);
    db.decisions.push(card("old", G1, "stale-rev"));
    const send = vi.fn(async () => ({ ids: [] }));
    vi.doMock("@/../workers/client", () => ({ inngest: { send } }));
    try {
      const { sendGoalAttention } = await import("../goal-attention");
      await sendGoalAttention({ tenant_id: T, reason: "goal_set", goal_id: G1 });
    } finally {
      vi.doUnmock("@/../workers/client");
    }
    expect(db.decisions[0].status).toBe("proposed");
    expect(db.autopilot_goals[0].cgo_status_line).toContain("6 of 40");
    expect(send.mock.calls).toEqual([[{ name: "growth/goal.attention", data: { tenant_id: T, reason: "goal_set", goal_id: G1 } }]]);
  });

  it("does not write a line computed from a goal that changed after it was read", async () => {
    const g = goal(G1, { updated_at: "2026-09-26T11:00:00Z", cgo_status_line: "6 of 40 weekly signups, 35 days left" } as Partial<GoalRow>);
    db.autopilot_goals.push(g);
    const origThen = Query.prototype.then;
    let reads = 0;
    Query.prototype.then = function (this: Query, ok, bad) {
      const r = origThen.call(this, ok, bad);
      if ((this as unknown as { table: string }).table === "autopilot_goals" && reads++ === 0) {
        db.autopilot_goals[0] = { ...g, target_value: 40, updated_at: "2026-09-26T11:30:00Z" };
      }
      return r;
    } as typeof origThen;
    try {
      await syncGoalWork(T, G1, NOW);
    } finally {
      Query.prototype.then = origThen;
    }
    expect(db.autopilot_goals[0].cgo_status_line).toBe("6 of 40 weekly signups, 35 days left");
  });

  it("leaves a paused goal's open cards and status line alone, so pause then resume loses nothing", async () => {
    db.autopilot_goals.push(goal(G1, { status: "paused", cgo_status_line: "kept" } as Partial<GoalRow>));
    db.decisions.push(card("a", G1, goalRev(db.autopilot_goals[0] as unknown as GoalRow)));
    await syncGoalWork(T, G1, NOW);
    expect(db.decisions[0].status).toBe("proposed");
    expect(db.autopilot_goals[0].cgo_status_line).toBe("kept");
  });
});

describe("a goal question asked about an older version of the goal", () => {
  const question = (id: string, goal_id: string, goal_rev: string, over: Row = {}): Row => ({
    id,
    tenant_id: T,
    topic_key: `goal:${goal_id}`,
    ask: "Should I raise the target to 30?",
    status: "open",
    asked_run_id: "run-ask",
    asked_at: "2026-09-25T12:00:00Z",
    expires_at: "2026-09-29T12:00:00Z",
    on_yes: { kind: "goal_change", goal_id, goal_rev, change: { target_value: 30 }, why: "You are ahead." },
    ...over,
  });
  const statuses = () => Object.fromEntries(db.cgo_questions.map((q) => [q.id, q.status]));

  it("is withdrawn by the next review; a current one, a plain one and another tenant's stay open", async () => {
    db.autopilot_goals.push(goal(G1), goal(G2, { objective: "Reach 50 hosts", target_metric: "hosts", target_value: 50 }));
    const asked = goalRev(goal(G1) as GoalRow);
    db.cgo_questions.push(
      question("q-old", G1, asked),
      question("q-live", G2, goalRev(db.autopilot_goals[1] as unknown as GoalRow)),
      { id: "q-plain", tenant_id: T, topic_key: "channel:seo", ask: "Keep SEO going?", status: "open", on_yes: null, asked_at: "2026-09-25T12:00:00Z", expires_at: "2026-09-29T12:00:00Z" },
      question("q-other", G1, asked, { tenant_id: OTHER }),
    );
    db.autopilot_goals[0].target_value = 25;
    await applyGoalMoves(T, "run-2", review([]), { emitDecision: emitter().emitDecision, resolveRepo: noRepo, now: NOW });
    expect(statuses()).toEqual({ "q-old": "withdrawn", "q-live": "open", "q-plain": "open", "q-other": "open" });
  });

  it("its yes changes nothing after the founder puts the goal back", async () => {
    db.autopilot_goals.push(goal(G1));
    db.cgo_questions.push(question("q-old", G1, goalRev(goal(G1) as GoalRow)));
    db.autopilot_goals[0].target_value = 25;
    await applyGoalMoves(T, "run-2", review([]), { emitDecision: emitter().emitDecision, resolveRepo: noRepo, now: NOW });
    expect(statuses()).toEqual({ "q-old": "withdrawn" });
    db.autopilot_goals[0].target_value = 20;
    expect(goalRev(db.autopilot_goals[0] as unknown as GoalRow)).toBe((db.cgo_questions[0].on_yes as Row).goal_rev);
    const { answerQuestions } = await import("../cgo-answers");
    const wake = vi.fn(async () => {});
    const out = await answerQuestions(
      { tenant_id: T, answers: [{ question_id: "q-old", answer: "yes" }], via: "email", actor_user_id: null, now: NOW },
      { wake },
    );
    expect(out.map((o) => o.outcome)).toEqual(["closed"]);
    expect(db.autopilot_goals[0].target_value).toBe(20);
    expect(db.autopilot_goals[0].cgo_undo ?? null).toBeNull();
    expect(db.cgo_questions[0]).toMatchObject({ status: "withdrawn" });
    expect(wake).not.toHaveBeenCalled();
  });

  it("while it is still open (no review ran), a yes on the edited goal applies nothing", async () => {
    db.autopilot_goals.push(goal(G1));
    const q = question("q-old", G1, goalRev(goal(G1) as GoalRow));
    db.cgo_questions.push(q);
    db.autopilot_goals[0].target_value = 25;
    const { answerQuestions } = await import("../cgo-answers");
    const out = await answerQuestions(
      { tenant_id: T, answers: [{ question_id: "q-old", answer: "yes" }], via: "web", actor_user_id: null, now: NOW },
      { wake: async () => {} },
    );
    expect(out[0]).toMatchObject({ outcome: "answered", applied: null });
    expect(db.autopilot_goals[0].target_value).toBe(25);
  });
});

describe("creator_caps (plan 2026-09-29-cgo-creator-hires, S1)", () => {
  const block = (caps: unknown) => `<goal_moves>${JSON.stringify({ goals: [], creator_caps: caps })}</goal_moves>`;

  it("parses per-hire, per-week and why", () => {
    const p = parseGoalMoves(block({ per_hire_usd: 200, per_week_usd: 600, why: " two test creators a week " }));
    expect(p.ok && p.value.creator_caps).toEqual({ per_hire_usd: 200, per_week_usd: 600, why: "two test creators a week" });
  });

  it.each([
    ["zero per hire", { per_hire_usd: 0, per_week_usd: 600, why: "x" }],
    ["negative per week", { per_hire_usd: 100, per_week_usd: -1, why: "x" }],
    ["a string amount", { per_hire_usd: "200", per_week_usd: 600, why: "x" }],
    ["no why", { per_hire_usd: 200, per_week_usd: 600 }],
    ["a blank why", { per_hire_usd: 200, per_week_usd: 600, why: "   " }],
    ["a why over 300 characters", { per_hire_usd: 200, per_week_usd: 600, why: "x".repeat(301) }],
    ["an absurd amount", { per_hire_usd: 1e7, per_week_usd: 1e7, why: "x" }],
  ])("drops bad caps (%s) but keeps the review", (_label, caps) => {
    const p = parseGoalMoves(block(caps));
    expect(p.ok).toBe(true);
    expect(p.ok && p.value.creator_caps).toBeUndefined();
  });

  it("applyGoalMoves stores exactly one caps version, stamped with the run, for the run's tenant", async () => {
    const { emitDecision } = emitter();
    rpcResult.record_cgo_creator_caps = { status: "recorded", id: "caps-1" };
    const out = await applyGoalMoves(
      T,
      "run-7",
      review([], { creator_caps: { per_hire_usd: 200, per_week_usd: 600, why: "two test creators a week" } }),
      { emitDecision, resolveRepo: noRepo, now: NOW, meta: { kind: "scheduled", alarm_keys: [], autopilot: true } },
    );
    expect(rpcCalls.filter((c) => c.fn === "record_cgo_creator_caps").map((c) => c.args)).toEqual([
      { p_tenant_id: T, p_per_hire_usd: 200, p_per_week_usd: 600, p_why: "two test creators a week", p_run_id: "run-7" },
    ]);
    expect(out.creator_caps_id).toBe("caps-1");
  });

  it("no creator_caps: nothing is written", async () => {
    const { emitDecision } = emitter();
    const out = await applyGoalMoves(T, "run-7", review([]), { emitDecision, resolveRepo: noRepo, now: NOW });
    expect(rpcCalls.filter((c) => c.fn === "record_cgo_creator_caps")).toHaveLength(0);
    expect(out.creator_caps_id).toBeUndefined();
  });

  it("a failed caps write is refused on the note, never a stored version", async () => {
    const { emitDecision } = emitter();
    const out = await applyGoalMoves(
      T,
      "run-7",
      review([], { creator_caps: { per_hire_usd: 200, per_week_usd: 600, why: "x" } }),
      { emitDecision, resolveRepo: noRepo, now: NOW, meta: { kind: "scheduled", alarm_keys: [], autopilot: true } },
    );
    expect(out.creator_caps_id).toBeUndefined();
    expect(db.cgo_notes[0]?.refused).toEqual(expect.arrayContaining([expect.stringContaining("Creator caps: not stored")]));
  });
});

describe("note contract (PLAN-cgo-note-rebuild B3)", () => {
  it("parses action, usd_at_stake and headline; an over-long action is dropped, never truncated", () => {
    const r = parseGoalMoves(`<goal_moves>${JSON.stringify({
      note: { headline: "Google spent $468 this week and counted 0 sign-ups." },
      channel_cards: [
        { action_id: "a", decision: "leave", why: "x", action: "Have your developer add hashed email to CAPI", usd_at_stake: 468 },
        { action_id: "b", decision: "leave", why: "y", action: "x".repeat(61), usd_at_stake: "lots" },
        { action_id: "c", decision: "leave", why: "z", usd_at_stake: -4 },
      ],
      goals: [{ goal_id: G1, moves: [{ target_agent_slug: "google_ads", intent: "hold", action: "Holding Search budgets at $55 and $25/day" }] }],
    })}</goal_moves>`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const cc = r.value.channel_cards!;
    expect(cc[0]).toMatchObject({ action: "Have your developer add hashed email to CAPI", usd_at_stake: 468 });
    expect(cc[1].action).toBeUndefined();
    expect(cc[1].usd_at_stake).toBeUndefined();
    expect(cc[2].usd_at_stake).toBeUndefined();
    expect(r.value.goals[0].moves[0].action).toBe("Holding Search budgets at $55 and $25/day");
    expect(r.value.note?.headline).toBe("Google spent $468 this week and counted 0 sign-ups.");
  });
});

describe("note items (PLAN-cgo-note-rebuild B4)", () => {
  const acts = { kind: "scheduled" as const, alarm_keys: [], autopilot: true };
  const budget = { id: "b-1", tenant_id: T, status: "active", monthly_usd: 1000, spent_usd: 0, held_usd: 0, daily_limit_usd: null };
  const card = (id: string, over: Row = {}): Row => ({
    id,
    tenant_id: T,
    run_id: "ch-run",
    channel_slug: "google_ads",
    title: `Card ${id}`,
    body: { step: { body: `Step of ${id}` } },
    exec_class: null,
    exec_payload: null,
    exec_status: null,
    exec_result: null,
    status: "pending",
    proposed_at: "2026-09-20T00:00:00Z",
    repeat_of: null,
    ...over,
  });
  const shownOf = (rows: Row[]) => new Map(rows.map((r) => [String(r.id), { channel_slug: String(r.channel_slug), title: String(r.title) }]));
  const noteItemsOf = (i = 0) => db.cgo_notes[i].items as Array<Row> | null;

  beforeEach(() => {
    db.autopilot_goals.push(goal(G1));
    db.ad_budgets = [budget];
    db.channel_actions = [];
    rpcResult = { set_channel_action: { ok: true } };
  });

  it("an auto-run is Working on, in cgo's words; the legacy line is unchanged", async () => {
    const autoRun = vi.fn(async () => true);
    await applyGoalMoves(
      T,
      "run-1",
      review([{ goal_id: G1, moves: [{ target_agent_slug: "meta_ads", intent: "test a $30/day ad set on the best creative", why: "because the best creative has 3x the CTR.", action: "Testing a $30/day ad set on the best creative" }] }]),
      { emitDecision: emitter().emitDecision, resolveRepo: noRepo, now: NOW, autoRun, autorunChannels: async () => new Set(["meta_ads"]), meta: acts },
    );
    expect(db.cgo_notes[0].changed).toEqual(["Started Meta Ads: test a $30/day ad set on the best creative"]);
    expect(noteItemsOf()).toEqual([
      { section: "working_on", text: "Meta Ads: Testing a $30/day ad set on the best creative", reason: "The best creative has 3x the CTR", channel_slug: "meta_ads" },
    ]);
  });

  it("leave, blocked and needs-founder cards land in the right sections, ids stripped", async () => {
    const rows = [
      card("c1", { title: "Fix sign_up_complete (8 hidden — follow-up on [9358264e])" }),
      card("c2", { channel_slug: "youtube_ads", title: "Create “Upcar - YouTube - Bay Area - zavi-brief-18df3c487111”", exec_class: "google_ads.create_campaign", exec_payload: { name: "Upcar - YouTube" }, exec_status: "failed", exec_result: { error: 'Google Ads create failed: 400 {"errorCode": {"mutateError": "MUTATE_NOT_ALLOWED"}}' } }),
      card("c3", { channel_slug: "meta_ads", exec_class: "meta_ads.set_status", exec_payload: { object_id: "111111111111", status: "ACTIVE" }, exec_status: "failed", exec_result: { code: "meta_ads_token_expired", error: "token expired" } }),
    ];
    db.channel_actions.push(...rows);
    const approve = vi.fn(async () => true);
    await applyGoalMoves(
      T,
      "run-1",
      review([], {
        channel_cards: [
          { action_id: "c1", decision: "leave", why: "$468 spent in 7 days with 0 counted sign-ups", action: "Count sign-ups as conversions in Google Ads", usd_at_stake: 468 },
          { action_id: "c2", decision: "leave", why: "the bid still shows manual CPV" },
          { action_id: "c3", decision: "approve", why: "turn it back on" },
        ],
      }),
      { emitDecision: emitter().emitDecision, resolveRepo: noRepo, now: NOW, meta: acts, shownCards: shownOf(rows), approveChannelAction: approve },
    );
    expect(approve).not.toHaveBeenCalled();
    const items = noteItemsOf()!;
    expect(items).toEqual([
      { section: "needs_you", text: "Count sign-ups as conversions in Google Ads", reason: "$468 spent in 7 days with 0 counted sign-ups", usd_at_stake: 468, title: "Fix sign_up_complete (8 hidden)", action_id: "c1", channel_slug: "google_ads", waiting_since: "2026-09-20T00:00:00Z", chain_root_id: "c1", blocker_id: "card:c1", blocker_severity: "normal" },
      { section: "needs_you", text: "Card c3", reason: "This needs you: reconnect Meta Ads in Settings", title: "Card c3", action_id: "c3", channel_slug: "meta_ads", waiting_since: "2026-09-20T00:00:00Z", chain_root_id: "c3", blocker_id: "connector:meta_ads", blocker_severity: "urgent" },
      { section: "blocked", text: "Create “Upcar - YouTube - Bay Area”", reason: "Google Ads refused this change. We've been alerted; nothing for you to do", action_id: "c2", channel_slug: "youtube_ads", waiting_since: "2026-09-20T00:00:00Z", chain_root_id: "c2" },
    ]);
    expect(db.cgo_notes[0].refused).toEqual(expect.arrayContaining([expect.stringContaining("it needs the founder's fix first")]));
    expect(JSON.stringify(items)).not.toMatch(/zavi-brief|\[[0-9a-f]{8}\]/);
    expect(db.cgo_notes[0].headline).toBe("2 things need you. First: Count sign-ups as conversions in Google Ads.");
  });

  it("What I changed lists only changes that landed: queued is Working on, executed is Applied, failed is placed by its verdict", async () => {
    const exec = { exec_class: "meta_ads.set_status", exec_payload: { object_id: "111111111111", status: "PAUSED", name: "SF - Leads" }, channel_slug: "meta_ads", title: "Pause SF - Leads" };
    for (const [final, expected] of [
      [{ exec_status: "queued" }, { section: "working_on", text: "Applying: Pause SF - Leads" }],
      [{ exec_status: "executed" }, { section: "changed", text: "Applied: Pause SF - Leads" }],
      [{ exec_status: "failed", exec_result: { code: "insufficient_credits" } }, { section: "needs_you", text: "Pause SF - Leads", reason: "This needs you: top up your Zavi credits" }],
      [{ exec_status: "failed", exec_result: { error: "Meta Ads failed: 400 (#100) Invalid parameter" , code: null, bucket: "blocked_on_us" } }, { section: "blocked", text: "Pause SF - Leads" }],
    ] as const) {
      db.cgo_notes.length = 0;
      db.channel_actions.length = 0;
      db.channel_actions.push(card("c4", exec));
      const approve = vi.fn(async (_t: string, id: string) => {
        Object.assign(db.channel_actions.find((r) => r.id === id)!, final);
        return true;
      });
      await applyGoalMoves(T, `run-${final.exec_status}`, review([], { channel_cards: [{ action_id: "c4", decision: "approve", why: "" }] }), {
        emitDecision: emitter().emitDecision,
        resolveRepo: noRepo,
        now: NOW,
        meta: acts,
        shownCards: shownOf([card("c4", exec)]),
        approveChannelAction: approve,
      });
      expect(noteItemsOf()).toEqual([expect.objectContaining(expected)]);
      expect(noteItemsOf()![0]).not.toHaveProperty("approved");
    }
  });

  it("a goal change and a pause are undoable changes; a reject is not", async () => {
    db.tenant_channels.push({ tenant_id: T, channel_slug: "reddit_organic" });
    db.channel_actions.push(card("c5", { channel_slug: "meta_ads" }));
    rpcResult.pause_channel_by_cgo = "ok";
    const rev = new Map([[G1, goalRev(goal(G1) as GoalRow)]]);
    await applyGoalMoves(
      T,
      "run-1",
      review([], {
        goal_changes: [{ goal_id: G1, objective: "Reach 3,000 MRR", target_metric: "mrr", target_value: 3000, why: "Revenue is the goal." }],
        channel_changes: [{ channel_slug: "reddit_organic", action: "pause", why: "9 posts untouched for 9 days." }],
        channel_cards: [{ action_id: "c5", decision: "reject", why: "Tested last month." }],
      }),
      { emitDecision: emitter().emitDecision, resolveRepo: noRepo, now: NOW, meta: acts, reviewedRevs: rev, evidence: perItem("reddit_organic"), shownCards: shownOf([card("c5", { channel_slug: "meta_ads" })]) },
    );
    const items = noteItemsOf()!;
    expect(items.find((i) => String(i.text).startsWith("Goal"))).toMatchObject({ section: "changed", goal_id: G1, undoable: true });
    expect(items.find((i) => String(i.text).startsWith("Paused"))).toMatchObject({ section: "changed", channel_slug: "reddit_organic", undoable: true });
    const rej = items.find((i) => String(i.text).startsWith("Said no to"))!;
    expect(rej).toMatchObject({ section: "decided", text: "Said no to: Card c5", reason: "Tested last month" });
    expect(rej.undoable).toBeUndefined();
  });

  it("a Blocked-only note is shown and pings once, even on the ads clock; the next review does not repeat it", async () => {
    db.cgo_notes.push({ id: "old", tenant_id: T, created_at: "2026-09-25T00:00:00Z", changed: ["x"], need: [], would_change: [], items: null });
    db.channel_actions.push(
      card("b1", { channel_slug: "youtube_ads", title: "Create YT campaign", status: "stale", status_at: "2026-09-26T08:00:00Z", exec_class: "google_ads.create_campaign", exec_status: "failed", exec_result: { bucket: "blocked_on_us", platform_code: "MUTATE_NOT_ALLOWED" } }),
      card("b0", { channel_slug: "youtube_ads", status: "stale", status_at: "2026-09-24T08:00:00Z", exec_class: "google_ads.create_campaign", exec_status: "failed", exec_result: { bucket: "blocked_on_us" } }),
      card("s1", { status: "stale", status_at: "2026-09-26T08:00:00Z", exec_status: "failed", exec_result: { bucket: "temporary" } }),
    );
    const clock = { kind: "alarm" as const, alarm_keys: [], autopilot: true, ads_clock: true };
    const res = await applyGoalMoves(T, "run-1", review([]), { emitDecision: emitter().emitDecision, resolveRepo: noRepo, now: NOW, meta: clock });
    const note = db.cgo_notes.at(-1)!;
    expect(note.items).toEqual([
      { section: "blocked", text: "Create YT campaign", reason: "Google Ads refused this change. We've been alerted; nothing for you to do", action_id: "b1", channel_slug: "youtube_ads", chain_root_id: "b1" },
    ]);
    expect(note.changed).toEqual([]);
    expect(note.headline).toBe("Google refused one change; nothing for you to do.");
    expect(res).toMatchObject({ note_visible: true, note_notify: true });
    note.created_at = "2026-09-26T12:00:00Z";
    const res2 = await applyGoalMoves(T, "run-2", review([]), { emitDecision: emitter().emitDecision, resolveRepo: noRepo, now: new Date("2026-09-26T16:00:00Z"), meta: clock });
    expect(db.cgo_notes.at(-1)!.items).toBeNull();
    expect(res2).toMatchObject({ note_visible: false, note_notify: false });
  });

  it("a card closed as blocked while the last note was being written is told by the next note, once", async () => {
    db.cgo_notes.push({ id: "last", tenant_id: T, created_at: "2026-09-26T10:00:00Z", changed: [], need: [], would_change: [], items: [{ section: "blocked", text: "Create YT", action_id: "b1", channel_slug: "youtube_ads" }] });
    const blocked = (id: string, at: string) => card(id, { channel_slug: "youtube_ads", title: `Card ${id}`, status: "stale", status_at: at, exec_class: "google_ads.create_campaign", exec_status: "failed", exec_result: { bucket: "blocked_on_us" } });
    db.channel_actions.push(blocked("b1", "2026-09-26T09:59:00Z"), blocked("b2", "2026-09-26T09:59:58Z"), blocked("b0", "2026-09-26T09:00:00Z"));
    await applyGoalMoves(T, "run-1", review([]), { emitDecision: emitter().emitDecision, resolveRepo: noRepo, now: NOW, meta: acts });
    expect((db.cgo_notes.at(-1)!.items as Row[]).map((i) => i.action_id)).toEqual(["b2"]);
  });

  it("a direct blocker alert is not the review's last note: a card refused before it is still told by the next review", async () => {
    db.cgo_notes.push({ id: "review", tenant_id: T, created_at: "2026-09-25T00:00:00Z", changed: ["x"], need: [], would_change: [], items: null, alarm_keys: [] });
    db.channel_actions.push(card("b5", { channel_slug: "youtube_ads", title: "Create YT", status: "stale", status_at: "2026-09-26T08:00:00Z", exec_class: "google_ads.create_campaign", exec_status: "failed", exec_result: { bucket: "blocked_on_us" } }));
    db.cgo_notes.push({
      id: "alert",
      tenant_id: T,
      created_at: "2026-09-26T09:00:00Z",
      changed: [],
      need: [],
      would_change: [],
      items: [{ section: "needs_you", text: "Reconnect Meta Ads in Settings", blocker_id: "connector:meta_ads" }],
      alarm_keys: ["cgo_blockers", "urgent"],
    });
    await applyGoalMoves(T, "run-1", review([]), { emitDecision: emitter().emitDecision, resolveRepo: noRepo, now: NOW, meta: acts });
    expect((db.cgo_notes.at(-1)!.items as Row[]).map((i) => i.action_id)).toEqual(["b5"]);
  });

  it("a card left again is not repeated in the items either (the once-only rule)", async () => {
    db.channel_actions.push(card("c6", { channel_slug: "x_organic", title: "X post: hosts earn more" }));
    const decide = review([], { channel_cards: [{ action_id: "c6", decision: "leave", why: "Your call to post." }] });
    const deps = { emitDecision: emitter().emitDecision, resolveRepo: noRepo, now: NOW, meta: acts, shownCards: shownOf([card("c6", { channel_slug: "x_organic", title: "X post: hosts earn more" })]) };
    await applyGoalMoves(T, "run-1", decide, deps);
    expect(noteItemsOf(0)).toHaveLength(1);
    await applyGoalMoves(T, "run-2", decide, { ...deps, meta: { ...acts, last_need: db.cgo_notes[0].need as string[] } });
    expect(db.cgo_notes[1].items).toBeNull();
  });

  it("an ask the founder was sent is never repeated in later notes, however many reviews run, while it is unchanged", async () => {
    db.channel_actions.push(card("c8", { title: "Raise the Bay Area budget" }));
    const decide = review([], { channel_cards: [{ action_id: "c8", decision: "leave", why: "Your call.", usd_at_stake: 200 }] });
    const deps = { emitDecision: emitter().emitDecision, resolveRepo: noRepo, now: NOW, meta: acts, shownCards: shownOf([card("c8", { title: "Raise the Bay Area budget" })]) };
    const first = await applyGoalMoves(T, "run-1", decide, deps);
    expect(first.note_notify).toBe(true);
    expect(db.cgo_notes[0].notified).toBe(false);
    db.cgo_notes[0].notified = true;
    expect(noteItemsOf(0)).toEqual([expect.objectContaining({ action_id: "c8", blocker_id: "card:c8", blocker_severity: "normal" })]);
    for (const run of ["run-2", "run-3", "run-4"]) {
      const r = await applyGoalMoves(T, run, decide, deps);
      expect(r.note_notify).toBe(false);
    }
    expect(db.cgo_notes.slice(1).map((n) => [n.items, n.need, n.notified])).toEqual([
      [null, [], false],
      [null, [], false],
      [null, [], false],
    ]);
  });

  it("the same ask comes back when the money at stake moves enough, and stays an ask: no amount makes it urgent", async () => {
    db.channel_actions.push(card("c9", { title: "Raise the Bay Area budget" }));
    const deps = { emitDecision: emitter().emitDecision, resolveRepo: noRepo, now: NOW, meta: acts, shownCards: shownOf([card("c9", { title: "Raise the Bay Area budget" })]) };
    const leave = (usd: number) => review([], { channel_cards: [{ action_id: "c9", decision: "leave", why: "Your call.", usd_at_stake: usd }] });
    await applyGoalMoves(T, "run-1", leave(200), deps);
    db.cgo_notes[0].notified = true;
    await applyGoalMoves(T, "run-2", leave(220), deps);
    expect(db.cgo_notes[1].items).toBeNull();
    await applyGoalMoves(T, "run-3", leave(900), deps);
    expect(noteItemsOf(2)).toEqual([expect.objectContaining({ action_id: "c9", usd_at_stake: 900, blocker_severity: "normal" })]);
  });

  it("a new ask on the ads clock is not news by itself: it is told once, by the next review that sends", async () => {
    db.channel_actions.push(card("c10", { title: "Raise the Bay Area budget" }));
    const decide = review([], { channel_cards: [{ action_id: "c10", decision: "leave", why: "Your call." }] });
    const deps = { emitDecision: emitter().emitDecision, resolveRepo: noRepo, now: NOW, shownCards: shownOf([card("c10", { title: "Raise the Bay Area budget" })]) };
    const quiet = await applyGoalMoves(T, "run-1", decide, { ...deps, meta: { ...acts, kind: "alarm" as const, ads_clock: true } });
    expect(quiet).toMatchObject({ note_visible: true, note_notify: false });
    expect(db.cgo_notes[0].notification_key).toBeNull();
    const sent = await applyGoalMoves(T, "run-2", decide, { ...deps, meta: acts });
    expect(sent.note_notify).toBe(true);
    expect(noteItemsOf(1)).toEqual([expect.objectContaining({ action_id: "c10", blocker_id: "card:c10" })]);
    db.cgo_notes[1].notified = true;
    await applyGoalMoves(T, "run-3", decide, { ...deps, meta: acts });
    expect(noteItemsOf(2)).toBeNull();
  });

  it("an unsent approval stays pending on its original note without being recreated", async () => {
    db.channel_actions.push(card("c13", { title: "Approve the budget" }));
    const decide = review([], { channel_cards: [{ action_id: "c13", decision: "leave", why: "Your call." }] });
    const deps = { emitDecision: emitter().emitDecision, resolveRepo: noRepo, now: NOW, meta: acts, shownCards: shownOf([card("c13", { title: "Approve the budget" })]) };
    expect((await applyGoalMoves(T, "run-1", decide, deps)).note_notify).toBe(true);
    expect(db.cgo_notes[0].notified).toBe(false);
    await applyGoalMoves(T, "run-2", decide, deps);
    expect(noteItemsOf(1)).toBeNull();
    expect(db.cgo_notes[0].notification_key).toBe("review:run-1");
  });

  it("a build failure keeps the legacy note, alerts once per run through the outbox and logs", async () => {
    db.channel_actions.push(card("c7"));
    failReads.add("cgo_notes.items");
    const res = await applyGoalMoves(T, "run-x", review([], { channel_cards: [{ action_id: "c7", decision: "leave", why: "Your call." }] }), {
      emitDecision: emitter().emitDecision,
      resolveRepo: noRepo,
      now: NOW,
      meta: acts,
      shownCards: shownOf([card("c7")]),
    });
    const note = db.cgo_notes.at(-1)!;
    expect(note.items).toBeNull();
    expect(note.headline).toBeNull();
    expect(note.need).toEqual(["Left for you: Card c7, because Your call."]);
    expect(res.note_visible).toBe(true);
    expect(rpcCalls.filter((c) => c.fn === "enqueue_ops_alert").map((c) => c.args)).toEqual([
      expect.objectContaining({ p_dedupe_key: "note_items:run-x", p_source: "cgo.note", p_code: "note_items_failed", p_tenant_id: T }),
    ]);
    expect(logEvents).toEqual(expect.arrayContaining([expect.objectContaining({ source: "cgo.note", code: "note_items_failed" })]));
  });

  it("headline: cgo's is kept with ids stripped; none or an invalid one is derived", async () => {
    db.channel_actions.push(card("c8"));
    const deps = { emitDecision: emitter().emitDecision, resolveRepo: noRepo, now: NOW, meta: acts, shownCards: shownOf([card("c8")]) };
    await applyGoalMoves(T, "run-1", review([], { note: { need: [], questions: [], headline: "Fix [9358264e] first: Google counts 0 sign-ups" }, channel_cards: [{ action_id: "c8", decision: "leave", why: "Why." }] }), deps);
    expect(db.cgo_notes[0].headline).toBe("Fix first: Google counts 0 sign-ups");
    db.cgo_notes.length = 0;
    await applyGoalMoves(T, "run-2", review([], { note: { need: [], questions: [], headline: "ok" }, channel_cards: [{ action_id: "c8", decision: "leave", why: "Why." }] }), deps);
    expect(db.cgo_notes[0].headline).toBe("1 thing needs you. First: Card c8.");
  });

  it("a chain of repeat cards is one line (its root)", async () => {
    db.channel_actions.push(card("r1", { title: "Count sign-ups" }), card("r2", { title: "Count sign-ups again", repeat_of: "r1" }), card("r3", { title: "Count sign-ups, third", repeat_of: "r2" }));
    await applyGoalMoves(
      T,
      "run-1",
      review([], {
        channel_cards: [
          { action_id: "r3", decision: "leave", why: "Same fix.", usd_at_stake: 10 },
          { action_id: "r1", decision: "leave", why: "$468 spent with 0 counted sign-ups", action: "Count sign-ups as conversions" },
        ],
      }),
      { emitDecision: emitter().emitDecision, resolveRepo: noRepo, now: NOW, meta: acts, shownCards: shownOf([card("r1"), card("r3")]) },
    );
    expect(noteItemsOf()).toEqual([expect.objectContaining({ action_id: "r1", chain_root_id: "r1", text: "Count sign-ups as conversions", usd_at_stake: 10 })]);
  });
});

describe("the 474b01c0 replay (end to end)", () => {
  const UPCAR = "73db45ff-457e-4541-bc8f-bdb625390204";
  const YT1 = "5796afb7-15c8-47f9-9d85-40426982b5ce";
  const YT2 = "931ad19b-cbf0-4dff-a202-6d4d37ab03a3";
  const SIGN1 = "9358264e-5263-48aa-8a0c-77fbb422a2ed";
  const SIGN2 = "bc1ab690-2a4f-4ef7-a803-17aedc4cd33d";
  const CAPI = "c0ffee00-0000-4000-8000-000000000001";
  const GROWTH = `https://www.zaviagent.com/workspace?tab=growth-strategy&company=${UPCAR}`;
  const mutateNotAllowed = {
    error:
      'Google Ads create failed: 400 {"error": {"code": 400, "status": "INVALID_ARGUMENT", "details": [{"errors": [{"errorCode": {"mutateError": "MUTATE_NOT_ALLOWED"}, "message": "Mutates are not allowed for the requested resource."}]}]}}',
  };
  const row = (id: string, over: Row): Row => ({
    id,
    tenant_id: UPCAR,
    run_id: "ch-run",
    body: { step: { body: "" } },
    exec_class: null,
    exec_payload: null,
    exec_status: null,
    exec_result: null,
    status: "pending",
    repeat_of: null,
    proposed_at: "2026-09-24T00:00:00Z",
    ...over,
  });
  const EXPECTED_SLACK = [
    "*UpcarAI: Google spent $468 this week and counted 0 sign-ups. One fix lets it see them.*",
    "",
    "*Your calls*",
    `• Count sign-ups as conversions in Google Ads. $468 spent in 7 days with 0 counted sign-ups. <https://www.zaviagent.com/workspace?tab=channels&channel=google_ads&action=${SIGN1}&company=${UPCAR}|Open>`,
    "",
    `• Have your developer add hashed email to CAPI. Meta's 25 purchases for Sep 23 to 29 can't be matched to real renters. <https://www.zaviagent.com/workspace?tab=channels&channel=meta_ads&action=${CAPI}&company=${UPCAR}|Open>`,
    "",
    "*What I did*",
    "• Google Ads: Holding Search budgets at $55 and $25/day through Oct 7. No increases and no new campaigns until the week's numbers are in.",
    "",
    "• Create the Bay Area YouTube campaign. Google Ads refused this change. We've been alerted; nothing for you to do.",
    "",
    `Next full check-in: Oct 3 · I also check your ads every 4 hours during the day · <${GROWTH}|Open Growth Strategy>`,
  ].join("\n");

  let prevBase: string | undefined;
  beforeEach(() => {
    prevBase = process.env.WEB_BASE_URL;
    process.env.WEB_BASE_URL = "https://www.zaviagent.com";
    visible.add("google_ads");
    visible.add("youtube_ads");
  });
  afterEach(() => {
    if (prevBase === undefined) delete process.env.WEB_BASE_URL;
    else process.env.WEB_BASE_URL = prevBase;
    visible.delete("google_ads");
    visible.delete("youtube_ads");
  });

  it("builds one honest note and every surface renders the same sections", async () => {
    db.autopilot_goals.push(goal(G1, { tenant_id: UPCAR }));
    db.ad_budgets = [{ id: "b-1", tenant_id: UPCAR, status: "active", monthly_usd: 1000, spent_usd: 468, held_usd: 0, daily_limit_usd: null }];
    db.channel_actions = [
      row(YT1, { channel_slug: "youtube_ads", title: "Create the campaign “Upcar - YouTube - Bay Area - zavi-brief-18df3c487111”", exec_class: "google_ads.create_campaign", exec_payload: { name: "Upcar - YouTube - Bay Area - zavi-brief-18df3c487111" }, exec_status: "failed", exec_result: mutateNotAllowed }),
      row(YT2, { channel_slug: "youtube_ads", title: "Create the campaign “Upcar - YouTube - Bay Area - zavi-brief-18df3c487111”", exec_class: "google_ads.create_campaign", exec_payload: { name: "Upcar - YouTube - Bay Area - zavi-brief-18df3c487111" }, exec_status: "failed", exec_result: mutateNotAllowed, repeat_of: YT1, proposed_at: "2026-09-25T00:00:00Z" }),
      row(SIGN1, { channel_slug: "google_ads", title: "Fix sign_up_complete in Google Ads (8 hidden signups)" }),
      row(SIGN2, { channel_slug: "google_ads", title: "Fix sign_up_complete in Google Ads (8 hidden signups — follow-up on [9358264e])", repeat_of: SIGN1, proposed_at: "2026-09-25T00:00:00Z" }),
      row(CAPI, { channel_slug: "meta_ads", title: "Add hashed email to the Meta Conversions API", proposed_at: "2026-09-23T00:00:00Z" }),
    ];
    rpcResult = { set_channel_action: { ok: true } };
    const shown = new Map(db.channel_actions.map((r) => [String(r.id), { channel_slug: String(r.channel_slug), title: String(r.title) }]));
    const cgo = parseGoalMoves(`<goal_moves>${JSON.stringify({
      note: { headline: "Google spent $468 this week and counted 0 sign-ups. One fix lets it see them." },
      channel_cards: [
        { action_id: YT1, decision: "reject", action: "Create the Bay Area YouTube campaign", why: "Google turned it down on apply" },
        { action_id: YT2, decision: "leave", action: "Create the Bay Area YouTube campaign", why: "the bid still shows manual cost per view" },
        { action_id: SIGN1, decision: "leave", action: "Count sign-ups as conversions in Google Ads", why: "$468 spent in 7 days with 0 counted sign-ups", usd_at_stake: 468 },
        { action_id: SIGN2, decision: "leave", action: "Count sign-ups as conversions", why: "same fix as the signup-counting card" },
        { action_id: CAPI, decision: "leave", action: "Have your developer add hashed email to CAPI", why: "Meta's 25 purchases for Sep 23 to 29 can't be matched to real renters" },
      ],
      goals: [{ goal_id: G1, moves: [{ target_agent_slug: "google_ads", intent: "From Oct 1 to 7, keep Upcar Sales Search Campaign ($55/day) and Upcar.ai | Search ($25/day) at their current budgets.", action: "Holding Search budgets at $55 and $25/day through Oct 7", why: "no increases and no new campaigns until the week's numbers are in" }] }],
    })}</goal_moves>`);
    expect(cgo.ok).toBe(true);
    if (!cgo.ok) return;
    const autoRun = vi.fn(async () => true);
    const res = await applyGoalMoves(UPCAR, "2d1937df-0000-4000-8000-000000000000", cgo.value, {
      emitDecision: emitter().emitDecision,
      resolveRepo: noRepo,
      now: NOW,
      autoRun,
      autorunChannels: async () => new Set(["google_ads"]),
      shownCards: shown,
      meta: { kind: "alarm", alarm_keys: [], autopilot: true, ads_clock: true },
    });
    expect(autoRun).toHaveBeenCalledTimes(1);
    const note = db.cgo_notes.at(-1)!;
    expect(res).toMatchObject({ note_visible: true, note_notify: true });

    const { renderCgoNoteSlack, renderCgoNoteSlackMessage } = await import("../cgo-note-slack");
    const { parseNoteItems } = await import("../cgo-note-items");
    const items = parseNoteItems(note.items)!;
    const slackIn = {
      companyName: "UpcarAI",
      changed: note.changed as string[],
      wouldChange: note.would_change as string[],
      need: note.need as string[],
      nextReviewAt: note.next_review_at as string,
      adsEvery2h: true,
      growthUrl: GROWTH,
      items,
      headline: note.headline as string,
      tenantId: UPCAR,
    };
    const slack = renderCgoNoteSlack(slackIn);
    expect(slack).toBe(EXPECTED_SLACK);
    const blocks = JSON.stringify(renderCgoNoteSlackMessage(slackIn).blocks);
    for (const l of EXPECTED_SLACK.split("\n").filter((x) => x.startsWith("• "))) expect(blocks).toContain(JSON.stringify(l.replace(/ <[^>]*\|Open>$/, "")).slice(1, -1));

    const sectionOf = new Map<string, string>();
    for (const i of items) {
      if (!i.action_id) continue;
      const root = i.chain_root_id ?? i.action_id;
      expect(sectionOf.has(root), `${root} in two sections`).toBe(false);
      sectionOf.set(root, i.section);
    }
    expect(JSON.stringify(items)).not.toMatch(/because The|zavi-brief-|\[9358264e\]/);
    expect(items.filter((i) => /sign-ups|sign_up_complete/.test(i.text))).toHaveLength(1);
    expect(items.find((i) => i.section === "working_on")?.text).toBe("Google Ads: Holding Search budgets at $55 and $25/day through Oct 7");
    expect(items[0]).toMatchObject({ action_id: SIGN1, usd_at_stake: 468 });
    expect(slack).not.toContain("Started Google Ads");
    expect(slack).not.toContain("This was a mistake");
    expect(note.changed).toEqual(expect.arrayContaining([expect.stringMatching(/^Rejected the YouTube Ads card/), expect.stringMatching(/^Started Google Ads:/)]));

    const { renderCgoNoteEmail } = await import("@/email/templates/cgo-note");
    const email = renderCgoNoteEmail({ companyName: "UpcarAI", autopilot: true, growthUrl: GROWTH, saw: [], changed: slackIn.changed, wouldChange: slackIn.wouldChange, need: [], nextReviewAt: slackIn.nextReviewAt, adsEvery2h: true, items, headline: slackIn.headline, tenantId: UPCAR });
    expect(email.subject).toBe("UpcarAI: Google spent $468 this week and counted 0 sign-ups. One fix lets it see them.");
    const emailTitles = ["Your calls", "What I did"].map((t) => email.text.indexOf(`\n${t}\n`));
    expect(emailTitles.every((x) => x > 0)).toBe(true);
    expect([...emailTitles].sort((a, b) => a - b)).toEqual(emailTitles);
    expect(email.text).not.toContain("What I changed");
    expect(email.text).not.toContain("This was a mistake");
    const emailRows = email.text.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.replace(/ Open: \S+$/, "").slice(2));

    const { noteView } = await import("@/routes/workspace/growth-plan");
    const web = noteView({ ...(note as unknown as Parameters<typeof noteView>[0]), items: note.items, headline: note.headline as string });
    expect(web.headline).toBe(slackIn.headline);
    expect(web.sections!.map((s) => s.title)).toEqual(["Needs you", "Working on", "Blocked on Zavi"]);
    const webRows = web.sections!.flatMap((s) => s.rows.map((r) => r.line));
    expect(web.sections![0].rows.map((r) => r.url)).toEqual([
      `/workspace?tab=channels&channel=google_ads&action=${SIGN1}`,
      `/workspace?tab=channels&channel=meta_ads&action=${CAPI}`,
    ]);
    const slackRows = EXPECTED_SLACK.split("\n").filter((l) => l.startsWith("• ")).map((l) => l.slice(2).replace(/ <[^>]+\|Open>$/, ""));
    expect(webRows).toEqual(slackRows);
    expect(emailRows).toEqual(slackRows);
  });
});

describe("cgo spend: repeat orders, debt, legacy proposals, refused orders in the note", () => {
  const budget = { id: "b-1", tenant_id: T, status: "active", monthly_usd: 1000, spent_usd: 100, held_usd: 150, daily_limit_usd: null };
  const acts = { kind: "scheduled" as const, alarm_keys: [], autopilot: true };
  const INTENT = "launch a $50/day prospecting ad set on the best creative";
  const noDebt = async () => ({ daily_target_usd: 90, required_cumulative_usd: 100, actual_month_usd: 100, delivery_debt_usd: 0, days_left: 10, data_fresh: true });
  const debt = async () => ({ daily_target_usd: 90, required_cumulative_usd: 300, actual_month_usd: 100, delivery_debt_usd: 200, days_left: 10, data_fresh: true });
  const noAds = async () => ({ forecast_daily_usd: 0, actual_today_usd: 0 });
  const metaMove = (intent = INTENT, extra: Record<string, unknown> = {}) =>
    review([{ goal_id: G1, status_line: "6 of 20 signups", moves: [{ target_agent_slug: "meta_ads", intent, why: "", ...extra }] }]);
  function earlierOrder(executed: Array<{ exec_class: string; exec_payload?: unknown }>, runStatus = "success", channel = "meta_ads") {
    db.decisions.push({
      id: "card-old",
      tenant_id: T,
      decision_class: CGO_CARD_CLASS,
      status: "acted",
      approved_at: "2026-09-24T12:00:00Z",
      body: { goal_id: G1, target_agent_slug: channel, intent: INTENT, problem: "unspecified", goal_rev: goalRev(goal(G1) as GoalRow), dispatched_by: "cgo" },
    });
    db.agent_runs.push({ id: "run-old", tenant_id: T, agent_slug: channel, status: runStatus, payload: { source_decision_id: "card-old" } });
    db.channel_actions = executed.map((e, i) => ({ id: `ca-${i}`, tenant_id: T, run_id: "run-old", exec_status: "executed", exec_payload: {}, ...e }));
  }
  const run = (moves: GoalMoves, deps: Record<string, unknown> = {}) => {
    const e = emitter();
    const p = applyGoalMoves(T, `run-${db.cgo_notes.length + 1}`, moves, {
      emitDecision: e.emitDecision,
      resolveRepo: noRepo,
      now: NOW,
      autoRun: vi.fn(async () => true),
      spendPace: noDebt,
      liveForecast: noAds,
      approveAdDecision: vi.fn(async () => false),
      meta: acts,
      ...deps,
    } as never);
    return p.then((res) => ({ res, emitted: e.emitted }));
  };

  it("acceptance 3: a repeat Meta order within 7 days is dispatched when the first produced no live ad", async () => {
    db.autopilot_goals.push(goal(G1));
    db.ad_budgets = [budget];
    earlierOrder([{ exec_class: "meta_ads.create_ad_set" }]);
    const { emitted } = await run(metaMove());
    expect(emitted.map((e) => e.body.target_agent_slug)).toEqual(["meta_ads"]);
  });

  it("the same repeat is still held when the first order put a live ad up and spend is on pace", async () => {
    db.autopilot_goals.push(goal(G1));
    db.ad_budgets = [budget];
    earlierOrder([{ exec_class: "meta_ads.duplicate_ad_set" }]);
    const { emitted } = await run(metaMove());
    expect(emitted).toHaveLength(0);
    expect(db.cgo_notes[0].refused).toEqual(expect.arrayContaining([expect.stringMatching(/^Work for meta_ads on .*already ran on this problem this week/)]));
  });

  it("holds a repeat Reddit order after a confirmed launch while spend is on pace", async () => {
    visible.add("reddit_ads");
    try {
      db.autopilot_goals.push(goal(G1));
      db.ad_budgets = [budget];
      earlierOrder([{ exec_class: "reddit_ads.launch_campaign" }], "success", "reddit_ads");
      const move = review([{ goal_id: G1, moves: [{ target_agent_slug: "reddit_ads", intent: INTENT, why: "" }] }]);
      const { emitted } = await run(move);
      expect(emitted).toHaveLength(0);
      expect(db.cgo_notes[0].refused).toEqual(expect.arrayContaining([expect.stringMatching(/^Work for reddit_ads on .*already ran on this problem this week/)]));
    } finally {
      visible.delete("reddit_ads");
    }
  });

  it("an earlier order whose run is still going is not 'no live ad' yet: the repeat waits", async () => {
    db.autopilot_goals.push(goal(G1));
    db.ad_budgets = [budget];
    earlierOrder([], "running");
    const { emitted } = await run(metaMove());
    expect(emitted).toHaveLength(0);
  });

  it("delivery debt over 15% of the daily target: the repeat goes out even after a live ad", async () => {
    db.autopilot_goals.push(goal(G1));
    db.ad_budgets = [budget];
    earlierOrder([{ exec_class: "meta_ads.update_ad_set_budget" }]);
    const { emitted } = await run(metaMove(), { spendPace: debt });
    expect(emitted.map((e) => e.body.target_agent_slug)).toEqual(["meta_ads"]);
  });

  it("a different order to the same channel is not a repeat; a non-ad agent keeps the goal+agent week rule", async () => {
    db.autopilot_goals.push(goal(G1));
    db.ad_budgets = [budget];
    earlierOrder([{ exec_class: "meta_ads.duplicate_ad_set" }]);
    const { emitted } = await run(metaMove("raise the best ad set 123456789012 to $200/day"));
    expect(emitted.map((e) => e.body.target_agent_slug)).toEqual(["meta_ads"]);
  });

  it("an open Meta card blocks only the same order", async () => {
    db.autopilot_goals.push(goal(G1));
    db.ad_budgets = [budget];
    db.decisions.push({
      id: "open-1",
      tenant_id: T,
      decision_class: CGO_CARD_CLASS,
      status: "proposed",
      body: { goal_id: G1, target_agent_slug: "meta_ads", intent: INTENT, goal_rev: goalRev(goal(G1) as GoalRow) },
    });
    const same = await run(metaMove());
    expect(same.emitted).toHaveLength(0);
    const other = await run(metaMove("set up retargeting for website visitors"));
    expect(other.emitted.map((e) => e.body.target_agent_slug)).toEqual(["meta_ads"]);
  });

  it("acceptance 4: proposed Meta create decisions are worked by cgo: approved, or withdrawn with a reason", async () => {
    db.autopilot_goals.push(goal(G1));
    db.ad_budgets = [budget];
    const create = (id: string, name: string, emitted_at: string, extra: Record<string, unknown> = {}) => ({
      id,
      tenant_id: T,
      agent_run_id: "run-pm",
      decision_class: "meta_ads.create_ad_set",
      status: "proposed",
      emitted_at,
      body: { campaign_id: "120200000000001", name, daily_budget_usd: 50, ...extra },
    });
    db.agent_runs.push({ id: "run-pm", tenant_id: T, agent_slug: "performance-marketer", status: "success", payload: {} });
    db.decisions.push(
      create("leg-new", "Prospecting", "2026-09-25T10:00:00Z"),
      create("leg-dup", "Prospecting", "2026-09-24T10:00:00Z"),
      create("leg-old", "Lookalike", "2026-09-15T10:00:00Z"),
      create("leg-founder", "Founder asked", "2026-09-25T11:00:00Z", { origin: "user_initiated_chat" }),
      { ...create("leg-other", "Prospecting", "2026-09-25T10:00:00Z"), tenant_id: OTHER },
    );
    const approveAdDecision = vi.fn(async () => true);
    await run(review([{ goal_id: G1, status_line: "6 of 20", moves: [] }]), { approveAdDecision, newerOpenCard: async () => false });
    expect(approveAdDecision.mock.calls).toEqual([
      [T, "leg-new", "meta_ads.create_ad_set", expect.objectContaining({ name: "Prospecting" }), "performance-marketer", { onHeld: expect.any(Function) }],
    ]);
    const status = (id: string) => db.decisions.find((d) => d.id === id)?.status;
    expect(status("leg-dup")).toBe("expired");
    expect(status("leg-old")).toBe("expired");
    expect(status("leg-founder")).toBe("proposed");
    expect(status("leg-other")).toBe("proposed");
    expect(db.cgo_notes[0].changed).toEqual(
      expect.arrayContaining([
        'Approved the waiting Meta Ads proposal to create ad set "Prospecting".',
        'Withdrew the waiting Meta Ads proposal to create ad set "Prospecting": a newer proposal for the same change is waiting.',
        'Withdrew the waiting Meta Ads proposal to create ad set "Lookalike": it waited more than a week and the account has changed since.',
      ]),
    );
  });

  it("an old proposal a newer open card covers is withdrawn, with no question (upcar-ai 2026-10-17)", async () => {
    db.autopilot_goals.push(goal(G1));
    db.ad_budgets = [budget];
    db.decisions.push({
      id: "leg-raise",
      tenant_id: T,
      decision_class: "meta_ads.create_ad_set",
      status: "proposed",
      emitted_at: "2026-09-25T09:03:40Z",
      body: { campaign_id: "120200000000001", name: "Sales Search", daily_budget_usd: 50 },
    });
    const approveAdDecision = vi.fn(async () => true);
    const newerOpenCard = vi.fn(async () => true);
    await run(review([{ goal_id: G1, status_line: "6 of 20", moves: [] }]), { approveAdDecision, newerOpenCard });
    expect(approveAdDecision).not.toHaveBeenCalled();
    expect(db.decisions.find((d) => d.id === "leg-raise")?.status).toBe("expired");
    expect(db.cgo_notes[0].changed).toEqual(
      expect.arrayContaining([
        'Withdrew the waiting Meta Ads proposal to create ad set "Sales Search": a newer card about the same campaign is waiting for you.',
      ]),
    );
  });

  it("an old proposal the gate holds is told in the review's own note, never by a question of its own", async () => {
    db.autopilot_goals.push(goal(G1));
    db.ad_budgets = [budget];
    db.decisions.push({
      id: "leg-held",
      tenant_id: T,
      decision_class: "meta_ads.create_ad_set",
      status: "proposed",
      emitted_at: "2026-09-25T10:00:00Z",
      body: { campaign_id: "120200000000001", name: "Prospecting", daily_budget_usd: 50 },
    });
    const approveAdDecision = vi.fn(async (_t: string, _id: string, _c: string, _b: unknown, _a?: string, opts?: { onHeld?: (r: string[]) => void }) => {
      opts?.onHeld?.(["learning_lock"]);
      return false;
    });
    await run(review([{ goal_id: G1, status_line: "6 of 20", moves: [] }]), { approveAdDecision, newerOpenCard: async () => false });
    expect(db.decisions.find((d) => d.id === "leg-held")?.status).toBe("proposed");
    const items = (db.cgo_notes[0].items ?? []) as Array<{ section: string; text: string }>;
    expect(items).toContainEqual(expect.objectContaining({ section: "needs_you", text: 'Left for you: the waiting Meta Ads proposal to create ad set "Prospecting"' }));
  });

  it("proposed ad decisions are untouched off Autopilot, or without a budget", async () => {
    db.autopilot_goals.push(goal(G1));
    db.decisions.push({ id: "leg-1", tenant_id: T, decision_class: "meta_ads.create_ad_set", status: "proposed", emitted_at: "2026-09-10T00:00:00Z", body: { name: "X", daily_budget_usd: 5 } });
    const approveAdDecision = vi.fn(async () => true);
    await run(review([{ goal_id: G1, status_line: "6 of 20", moves: [] }]), { approveAdDecision });
    db.ad_budgets = [budget];
    await run(review([{ goal_id: G1, status_line: "6 of 20", moves: [] }]), { approveAdDecision, meta: { kind: "scheduled", alarm_keys: [], autopilot: false } });
    expect(approveAdDecision).not.toHaveBeenCalled();
    expect(db.decisions.find((d) => d.id === "leg-1")?.status).toBe("proposed");
  });

  it("a refused ad order is shown in the founder's note, and alone does not ping on the ads clock", async () => {
    db.autopilot_goals.push(goal(G1));
    db.ad_budgets = [budget];
    const { res } = await run(metaMove(INTENT, { daily_usd: 5000 }), { meta: { ...acts, kind: "alarm", ads_clock: true } });
    const items = (db.cgo_notes[0].items ?? []) as Array<{ section: string; text: string; reason?: string }>;
    expect(items).toContainEqual(
      expect.objectContaining({
        section: "blocked",
        text: 'Did not start Meta Ads work for "Get 20 signups"',
        reason: "It asked for $5000/day of new ads and only $90/day fits this month",
      }),
    );
    expect(res).toMatchObject({ note_visible: true, note_notify: false });
  });

  it("while spend is behind pace the next review may be tomorrow; on pace it backs off", async () => {
    db.autopilot_goals.push(goal(G1));
    db.ad_budgets = [budget];
    const tomorrow = review([{ goal_id: G1, status_line: "6 of 20", moves: [] }], { next_review_in_days: 1 } as Partial<GoalMoves>);
    await run(tomorrow, { spendPace: debt });
    expect(db.cgo_notes[0].next_review_at).toBe("2026-09-27T12:00:00.000Z");
    await run(tomorrow, { spendPace: noDebt });
    expect(Date.parse(String(db.cgo_notes[1].next_review_at)) - NOW.getTime()).toBeGreaterThan(86_400_000);
  });
});

describe("cgo spend: pure helpers", () => {
  it("recognizes a Reddit launch or resume without counting paused preparation, a replacement, a pause, an edit or a budget change", () => {
    expect(producedLiveAd("reddit_ads.launch_campaign", {})).toBe(true);
    expect(producedLiveAd("reddit_ads.set_object_status", { status: "ACTIVE" })).toBe(true);
    expect(producedLiveAd("reddit_ads.set_object_status", { status: "PAUSED" })).toBe(false);
    for (const execClass of ["reddit_ads.prepare_campaign", "reddit_ads.update_budget", "reddit_ads.replace_creative", "reddit_ads.update_ad", "reddit_ads.update_targeting"]) {
      expect(producedLiveAd(execClass, {}), execClass).toBe(false);
    }
  });

  it("producedLiveAd: an empty PAUSED Meta create is not a live ad; raises, copies, new ads and switching on are", () => {
    expect(producedLiveAd("meta_ads.create_ad_set", {})).toBe(false);
    for (const c of ["meta_ads.update_ad_set_budget", "google_ads.update_campaign_budget", "meta_ads.duplicate_ad_set", "meta_ads.duplicate_campaign", "meta_ads.create_ad", "google_ads.create_campaign"]) {
      expect(producedLiveAd(c, {}), c).toBe(true);
    }
    expect(producedLiveAd("meta_ads.set_status", { status: "ACTIVE" })).toBe(true);
    expect(producedLiveAd("google_ads.set_status", { status: "ENABLED" })).toBe(true);
    expect(producedLiveAd("meta_ads.set_status", { status: "PAUSED" })).toBe(false);
    expect(producedLiveAd(null, {})).toBe(false);
  });

  it("ordersWithoutLiveAd: finished with nothing live; a running order or one with no run yet (under 2h) is not", () => {
    const now = new Date("2026-10-02T12:00:00Z");
    const orders = [
      { id: "a", approved_at: "2026-10-01T12:00:00Z" },
      { id: "b", approved_at: "2026-10-01T12:00:00Z" },
      { id: "c", approved_at: "2026-10-01T12:00:00Z" },
      { id: "d", approved_at: "2026-10-02T11:00:00Z" },
      { id: "e", approved_at: "2026-10-01T12:00:00Z" },
    ];
    const runs = [
      { id: "ra", status: "success", source_decision_id: "a" },
      { id: "rb", status: "success", source_decision_id: "b" },
      { id: "rc", status: "running", source_decision_id: "c" },
    ];
    const out = ordersWithoutLiveAd({ orders, runs, live: new Set(["rb"]), now });
    expect([...out].sort()).toEqual(["a", "e"]);
  });

  it("adIntentKey: the objects an order names, else its words", () => {
    expect(adIntentKey("Raise 120200000001 to $80")).toBe(adIntentKey("raise ad set 120200000001 by a lot"));
    expect(adIntentKey("Launch retargeting")).not.toBe(adIntentKey("Launch prospecting"));
    expect(adIntentKey("  Launch   Retargeting! ")).toBe(adIntentKey("launch retargeting"));
  });

  it("refusedMoveItems: only ad orders, in the founder's words, never a slug", () => {
    const items = refusedMoveItems([
      'Work for google_ads on "Get 50 bookings": it already ran on this problem this week; wait for its result.',
      'Work for research on "Get 50 bookings": a card for it is already waiting.',
      "Pause Reddit: left for the founder (pause_needs_founder).",
    ]);
    expect(items).toEqual([
      {
        section: "blocked",
        text: 'Did not start Google Ads work for "Get 50 bookings"',
        reason: "It already ran on this problem this week; wait for its result",
        channel_slug: "google_ads",
      },
    ]);
    for (const i of items) expect(`${i.text} ${i.reason}`).not.toMatch(/—|google_ads/);
  });

  it("PR2 item 5: Zavi's own open-card clash is never 'Google refused'; a real refusal still is", async () => {
    const { buildNoteItems, deriveHeadline } = await import("../cgo-note-items");
    const clash = refusedMoveItems([
      'Work for google_ads on "Get 50 bookings": a card for it is already waiting.',
      'Work for google_ads on "Get 50 bookings": it names the object of the channel\'s open card "Raise Brand Search".',
    ]);
    expect(clash).toEqual([]);
    const real = refusedMoveItems(['Work for google_ads on "Get 50 bookings": it asked for $40/day of new ads and only $10/day fits this month.']);
    expect(real).toHaveLength(1);
    expect(deriveHeadline(buildNoteItems(real))).toBe("Google refused one change; nothing for you to do.");
  });

  it("planLegacyAdDecisions: newest first, duplicates and stale ones withdrawn, the founder's own never touched", () => {
    const now = new Date("2026-10-02T12:00:00Z");
    const row = (id: string, emitted_at: string, body: Record<string, unknown>) => ({ id, decision_class: "meta_ads.update_ad_set_budget", body, emitted_at, agent_run_id: null });
    const plan = planLegacyAdDecisions(
      [
        row("old-same", "2026-10-01T00:00:00Z", { ad_set_id: "120200000001", daily_budget_usd: 60 }),
        row("new-same", "2026-10-02T00:00:00Z", { ad_set_id: "120200000001", daily_budget_usd: 80 }),
        row("stale", "2026-09-20T00:00:00Z", { ad_set_id: "120200000002", daily_budget_usd: 80 }),
        row("mine", "2026-10-02T00:00:00Z", { ad_set_id: "120200000003", daily_budget_usd: 80, origin: "user_initiated_ledger" }),
      ],
      now,
    );
    expect(plan.map((p) => [p.row.id, p.act, "why" in p ? p.why : null])).toEqual([
      ["new-same", "approve", null],
      ["old-same", "withdraw", "duplicate"],
      ["stale", "withdraw", "stale"],
    ]);
  });

  it("planLegacyAdDecisions: changes to two different ad sets that share a display name are not duplicates; creates still key by name", () => {
    const now = new Date("2026-10-02T12:00:00Z");
    const row = (id: string, decision_class: string, emitted_at: string, body: Record<string, unknown>) => ({ id, decision_class, body, emitted_at, agent_run_id: null });
    const plan = planLegacyAdDecisions(
      [
        row("raise-a", "meta_ads.update_ad_set_budget", "2026-10-02T01:00:00Z", { ad_set_id: "120200000011", daily_budget_usd: 80, name: "Prospecting" }),
        row("raise-b", "meta_ads.update_ad_set_budget", "2026-10-02T00:00:00Z", { ad_set_id: "120200000012", daily_budget_usd: 80, name: "Prospecting" }),
        row("on-a", "meta_ads.set_status", "2026-10-02T01:00:00Z", { object_id: "120200000011", status: "ACTIVE", name: "Prospecting" }),
        row("on-b", "meta_ads.set_status", "2026-10-02T00:00:00Z", { object_id: "120200000012", status: "ACTIVE", name: "Prospecting" }),
        row("copy-a", "meta_ads.duplicate_ad_set", "2026-10-02T01:00:00Z", { source_ad_set_id: "120200000011", daily_budget_usd: 50, name: "Prospecting (copy)" }),
        row("copy-b", "meta_ads.duplicate_ad_set", "2026-10-02T00:00:00Z", { source_ad_set_id: "120200000012", daily_budget_usd: 50, name: "Prospecting (copy)" }),
        row("raise-a-old", "meta_ads.update_ad_set_budget", "2026-10-01T00:00:00Z", { ad_set_id: "120200000011", daily_budget_usd: 60, name: "Other name" }),
        row("new-1", "meta_ads.create_ad_set", "2026-10-02T01:00:00Z", { campaign_id: "120200000001", name: "Retargeting", daily_budget_usd: 20 }),
        row("new-2", "meta_ads.create_ad_set", "2026-10-02T00:00:00Z", { campaign_id: "120200000001", name: "Retargeting", daily_budget_usd: 25 }),
      ],
      now,
    );
    const acts = Object.fromEntries(plan.map((p) => [p.row.id, p.act]));
    expect(acts).toMatchObject({ "raise-a": "approve", "raise-b": "approve", "on-a": "approve", "on-b": "approve", "copy-a": "approve", "copy-b": "approve" });
    expect(acts["raise-a-old"]).toBe("withdraw");
    expect(acts["new-1"]).toBe("approve");
  });
});

describe("plan-aware cgo", () => {
  const acts = { kind: "scheduled" as const, alarm_keys: [], autopilot: true };
  const adBudget = { id: "b-1", tenant_id: T, status: "active", monthly_usd: 1000, spent_usd: 100, held_usd: 150, daily_limit_usd: null };
  const organicMoves = () =>
    review([
      {
        goal_id: G1,
        status_line: "x",
        moves: [
          { target_agent_slug: "reddit_organic", intent: "Draft three Reddit posts.", why: "" },
          { target_agent_slug: "seo", intent: "Fix the top page titles.", why: "" },
        ],
      },
    ]);
  const LINE = "To reach more people for this goal, SEO and Reddit would help most. Both are in the Starter plan ($20/mo); meanwhile I'm working the channels you have";
  const pickReddit = () =>
    db.tenant_channels.push(
      { tenant_id: T, channel_slug: "reddit_organic", plan_selected: true },
      { tenant_id: T, channel_slug: "seo", plan_selected: true },
      { tenant_id: OTHER, channel_slug: "blog", plan_selected: true },
    );
  const researchOnly = () => review([{ goal_id: G1, status_line: "x", moves: [{ target_agent_slug: "research", intent: "count cancelled trips", why: "" }] }]);
  const planItems = () => db.cgo_notes.flatMap((n) => ((n.items as Array<Record<string, unknown>> | null) ?? []).filter((i) => i.plans === true));
  const contextOf = async () => {
    enqueueAgentRun.mockResolvedValue({ run_id: "r-1" });
    await enqueueGoalOwnerRun({ tenant_id: T, reason: "goal_set", now: NOW });
    return enqueueAgentRun.mock.calls.at(-1)![0].payload.memory.cgo_goals;
  };

  it("must-catch: a Free tenant under Autopilot is offered no channel; they are plan_locked with the plan that has them", async () => {
    tenantTier = "free";
    db.autopilot_goals.push(goal(G1));
    const ctx = await contextOf();
    for (const slug of ["reddit_organic", "seo", "email_marketing", "engineer"]) expect(ctx.allowed_agents).not.toContain(slug);
    expect(ctx.allowed_agents).toEqual(expect.arrayContaining(["research", "pm"]));
    expect(ctx.plan_locked).toEqual(
      expect.arrayContaining([
        { agent: "reddit_organic", needs_tier: "starter", price_usd: 20 },
        { agent: "seo", needs_tier: "starter", price_usd: 20 },
        { agent: "email_marketing", needs_tier: "pro", price_usd: 240 },
        { agent: "engineer", needs_tier: "pro", price_usd: 240 },
      ]),
    );
  });

  it("must-catch: a Free tenant's moves to Reddit and SEO make no card, are refused as not in the plan, and the server line says it once", async () => {
    tenantTier = "free";
    db.autopilot_goals.push(goal(G1));
    pickReddit();
    const { emitted, emitDecision } = emitter();
    const autoRun = vi.fn(async () => true);
    await applyGoalMoves(T, "run-1", organicMoves(), { emitDecision, resolveRepo: noRepo, now: NOW, autoRun, meta: acts });
    expect(emitted).toHaveLength(0);
    expect(autoRun).not.toHaveBeenCalled();
    expect(db.cgo_notes[0].refused).toEqual(
      expect.arrayContaining([expect.stringContaining("Work for reddit_organic on") , expect.stringContaining("not in this workspace's plan")]),
    );
    expect(planItems()).toEqual([{ section: "working_on", text: LINE, plans: true }]);
    expect(String(db.cgo_notes[0].headline ?? "")).not.toContain("To reach more people");

    db.cgo_notes[0].created_at = new Date(NOW.getTime() - 13 * 86_400_000).toISOString();
    await applyGoalMoves(T, "run-2", organicMoves(), { emitDecision, resolveRepo: noRepo, now: NOW, autoRun, meta: acts });
    expect(planItems()).toHaveLength(1);
    db.cgo_notes = [{ tenant_id: OTHER, created_at: NOW.toISOString(), items: [{ section: "working_on", text: LINE, plans: true }] }];
    await applyGoalMoves(T, "run-3", organicMoves(), { emitDecision, resolveRepo: noRepo, now: NOW, autoRun, meta: acts });
    expect(planItems().filter((i) => i)).toHaveLength(2);
    db.cgo_notes = db.cgo_notes.filter((n) => n.tenant_id === T).map((n) => ({ ...n, created_at: new Date(NOW.getTime() - 15 * 86_400_000).toISOString() }));
    await applyGoalMoves(T, "run-4", organicMoves(), { emitDecision, resolveRepo: noRepo, now: NOW, autoRun, meta: acts });
    expect(planItems()).toHaveLength(2);
  });

  it("must-catch: a downgraded tenant with an active ad budget has its ad channels locked too", async () => {
    tenantTier = "starter";
    db.autopilot_goals.push(goal(G1));
    db.ad_budgets = [adBudget];
    const ctx = await contextOf();
    expect(ctx.allowed_agents).not.toContain("meta_ads");
    expect(ctx.allowed_agents).not.toContain("google_ads");
    expect(ctx.plan_locked).toEqual(expect.arrayContaining([{ agent: "meta_ads", needs_tier: "pro", price_usd: 240 }, { agent: "google_ads", needs_tier: "pro", price_usd: 240 }]));
    expect(ctx.allowed_agents).toEqual(expect.arrayContaining(["reddit_organic", "seo", "linkedin_organic"]));

    const { emitted, emitDecision } = emitter();
    await applyGoalMoves(
      T,
      "run-1",
      review([{ goal_id: G1, moves: [{ target_agent_slug: "meta_ads", intent: "test a $30/day ad set", why: "", daily_usd: 30 } as never] }]),
      { emitDecision, resolveRepo: noRepo, now: NOW, autoRun: vi.fn(async () => true), meta: acts },
    );
    expect(emitted).toHaveLength(0);
    const [line] = planItems();
    expect(String(line.text)).toMatch(/^To reach more people for this goal, TikTok and .+ would help most\. Both are in the Growth plan \(\$120\/mo\); meanwhile I'm working the channels you have$/);
    expect(String(line.text)).not.toContain("Meta Ads");
    expect(((db.cgo_notes[0].items as Array<Record<string, unknown>>) ?? []).filter((i) => i.section === "blocked")).toEqual([]);
  });

  it("must-catch: an unreadable plan drops every gated slug, lists nothing as locked and says nothing", async () => {
    tenantTier = "throw";
    db.autopilot_goals.push(goal(G1));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ctx = await contextOf();
    expect(ctx.allowed_agents).toEqual(expect.arrayContaining(["research", "pm", "content-design"]));
    for (const slug of ["reddit_organic", "seo", "email_marketing", "engineer"]) expect(ctx.allowed_agents).not.toContain(slug);
    expect(ctx).not.toHaveProperty("plan_locked");
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("plan check failed"))).toHaveLength(1);

    const { emitted, emitDecision } = emitter();
    await applyGoalMoves(T, "run-1", organicMoves(), { emitDecision, resolveRepo: noRepo, now: NOW, autoRun: vi.fn(async () => true), meta: acts });
    expect(emitted).toHaveLength(0);
    expect(planItems()).toEqual([]);
    expect(db.cgo_notes[0].refused).toEqual(expect.arrayContaining([expect.stringContaining("not an agent you can hand work to right now")]));
    warn.mockRestore();
  });

  it("must-catch: an unreadable plan CONFIG does not offer gated channels (the dispatcher would refuse them later)", async () => {
    failReads.add("system_config");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    tenantTier = "free";
    const r = await allowedAgents(T, null, { on: true });
    for (const slug of ["reddit_organic", "seo", "email_marketing", "engineer", "content-design"]) expect(r.allowed).not.toContain(slug);
    expect(r.allowed).toEqual(expect.arrayContaining(["research", "pm"]));
    expect(r.locked).toEqual([]);
    failReads.delete("system_config");
    warn.mockRestore();
  });

  it("allowedAgents mirrors the dispatcher per slug: one throwing decide drops that slug only", async () => {
    const entitlement = await import("@/services/agents/entitlement");
    const real = entitlement.createTierGate;
    const spy = vi.spyOn(entitlement, "createTierGate").mockImplementation(() => {
      const gate = real();
      return {
        decide: async (t: string, slug: string, o?: Parameters<typeof gate.decide>[2]) => {
          if (slug === "seo") throw new Error("boom");
          return gate.decide(t, slug, o);
        },
      };
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    tenantTier = "starter";
    const r = await allowedAgents(T, null, { on: true });
    expect(r.allowed).toContain("reddit_organic");
    expect(r.allowed).not.toContain("seo");
    expect(r.locked.map((l) => l.agent)).not.toContain("seo");
    spy.mockRestore();
    warn.mockRestore();
  });

  it("must-not-touch: Starter, Growth and Pro keep every channel their plan includes", async () => {
    db.autopilot_goals.push(goal(G1));
    tenantTier = "starter";
    let r = await allowedAgents(T, null, { on: true });
    expect(r.allowed).toEqual(expect.arrayContaining(["reddit_organic", "seo", "linkedin_organic", "x_organic", "geo", "content-design"]));
    expect(r.allowed).not.toContain("blog");
    expect(r.locked.map((l) => l.agent).sort()).toEqual(expect.arrayContaining(["email_marketing", "engineer"]));
    tenantTier = "growth";
    r = await allowedAgents(T, null, { on: true });
    expect(r.allowed).toEqual(expect.arrayContaining(["reddit_organic", "seo", "tiktok_organic", "youtube_organic"]));
    tenantTier = "pro";
    r = await allowedAgents(T, { id: "b-1" } as never, { on: true });
    expect(r.locked).toEqual([]);
    expect(r.allowed).toEqual(expect.arrayContaining(["meta_ads", "google_ads", "email_marketing", "engineer", "reddit_organic"]));
    expect(await contextOf()).not.toHaveProperty("plan_locked");
  });

  it("must-catch: a Free tenant whose cgo moves only allowed agents still hears the line, once in 14 days", async () => {
    tenantTier = "free";
    db.autopilot_goals.push(goal(G1));
    pickReddit();
    const { emitted, emitDecision } = emitter();
    const autoRun = vi.fn(async () => true);
    await applyGoalMoves(T, "run-1", researchOnly(), { emitDecision, resolveRepo: noRepo, now: NOW, autoRun, meta: acts });
    expect(emitted.map((e) => e.body.target_agent_slug)).toEqual(["research"]);
    expect(planItems()).toEqual([{ section: "working_on", text: LINE, plans: true }]);
    db.cgo_notes[0].created_at = new Date(NOW.getTime() - 2 * 86_400_000).toISOString();
    await applyGoalMoves(T, "run-2", researchOnly(), { emitDecision, resolveRepo: noRepo, now: NOW, autoRun, meta: acts });
    expect(db.cgo_notes).toHaveLength(2);
    expect(planItems()).toHaveLength(1);
  });

  it("must-not-touch: a Pro tenant (nothing locked) and a tenant with only engineer locked hear no line", async () => {
    db.autopilot_goals.push(goal(G1));
    tenantTier = "pro";
    await applyGoalMoves(T, "run-1", researchOnly(), { emitDecision: emitter().emitDecision, resolveRepo: noRepo, now: NOW, autoRun: vi.fn(async () => true), meta: acts });
    expect(planItems()).toEqual([]);
    tenantTier = "starter";
    const locked = (await allowedAgents(T, null, { on: false })).locked;
    expect(locked.map((l) => l.agent)).toEqual(["engineer"]);
    await applyGoalMoves(T, "run-2", researchOnly(), {
      emitDecision: emitter().emitDecision,
      resolveRepo: noRepo,
      now: NOW,
      autoRun: vi.fn(async () => true),
      meta: { kind: "scheduled", alarm_keys: [], autopilot: false },
    });
    expect(db.cgo_notes).toHaveLength(2);
    expect(planItems()).toEqual([]);
  });

  it("names at most two locked channels of the lowest tier: the founder's picks first, then registry order; never engineer", () => {
    const L = (agent: string, needs_tier: "starter" | "growth" | "pro", price_usd: number) => ({ agent, needs_tier, price_usd });
    const locked = [L("engineer", "pro", 240), L("meta_ads", "pro", 240), L("tiktok_organic", "growth", 120), L("reddit_organic", "starter", 20), L("geo", "starter", 20), L("seo", "starter", 20)];
    const idx = (slug: string) => CHANNELS.findIndex((c) => c.slug === slug);
    const byRegistry = ["reddit_organic", "geo", "seo"].sort((a, b) => idx(a) - idx(b)).slice(0, 2);
    expect(pickPlanLineChannels(locked).map((l) => l.agent)).toEqual(byRegistry);
    expect(pickPlanLineChannels(locked, new Set(["reddit_organic"]))[0].agent).toBe("reddit_organic");
    expect(pickPlanLineChannels(locked, new Set(["meta_ads"])).every((l) => l.needs_tier === "starter")).toBe(true);
    expect(pickPlanLineChannels([L("engineer", "pro", 240)])).toEqual([]);
    expect(planLockedLine(pickPlanLineChannels([L("engineer", "pro", 240)]))).toBeNull();
  });

  it("the line: one channel or two, the plan that includes both, nothing for a non-channel", () => {
    expect(planLockedLine([{ agent: "seo", needs_tier: "starter", price_usd: 20 }])).toBe(
      "To reach more people for this goal, SEO would help most. It's in the Starter plan ($20/mo); meanwhile I'm working the channels you have",
    );
    expect(
      planLockedLine([
        { agent: "reddit_organic", needs_tier: "starter", price_usd: 20 },
        { agent: "meta_ads", needs_tier: "pro", price_usd: 240 },
        { agent: "seo", needs_tier: "starter", price_usd: 20 },
      ]),
    ).toBe("To reach more people for this goal, Reddit and Meta Ads would help most. Both are in the Pro plan ($240/mo); meanwhile I'm working the channels you have");
    expect(planLockedLine([{ agent: "engineer", needs_tier: "pro", price_usd: 240 }])).toBeNull();
    expect(planLockedLine([])).toBeNull();
  });
});

describe("founderRemovedChannels (Growth J6 founder stop)", () => {
  it("counts a stopped channel and a founder's own removed add, never Zavi's picks", async () => {
    const { founderRemovedChannels } = await import("../goal-owner");
    const out = founderRemovedChannels([
      { channel_slug: "seo", plan_selected: false, plan_selected_set_by: "founder_stopped" },
      { channel_slug: "pr", plan_selected: false, plan_selected_set_by: "founder" },
      { channel_slug: "geo", plan_selected: true, plan_selected_set_by: "plan" },
      { channel_slug: "x_organic", plan_selected: true, plan_selected_set_by: "founder" },
      { channel_slug: "reddit_organic", plan_selected: false, plan_selected_set_by: null },
    ]);
    expect([...out].sort()).toEqual(["pr", "seo"]);
  });

  it("a pause cgo tries on a stopped channel says nothing", async () => {
    const { pauseOutcomeLine } = await import("../goal-owner");
    expect(pauseOutcomeLine("founder_stopped", { name: "SEO", why: "x" })).toEqual({});
  });
});
