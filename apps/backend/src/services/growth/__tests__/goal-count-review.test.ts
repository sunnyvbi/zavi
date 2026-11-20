import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
const rpcCalls: Array<{ fn: string; args: Row }> = [];

class Query {
  private filters: Array<(r: Row) => boolean> = [];
  private op: "select" | "update" | "insert" = "select";
  private patch: Row = {};
  private single = false;
  private head = false;
  private lim = Infinity;
  constructor(private table: string) {}
  select(_c?: string, o?: { head?: boolean }) {
    if (o?.head) this.head = true;
    return this;
  }
  update(p: Row) {
    this.op = "update";
    this.patch = p;
    return this;
  }
  insert(r: Row | Row[]) {
    this.op = "insert";
    this.patch = Array.isArray(r) ? r[0] : r;
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this;
  }
  eq(c: string, v: unknown) {
    const m = /^(\w+)->>(\w+)$/.exec(c);
    this.filters.push((r) => (m ? String((r[m[1]] as Row | null)?.[m[2]] ?? "") : r[c]) === v);
    return this;
  }
  neq(c: string, v: unknown) {
    this.filters.push((r) => r[c] != null && r[c] !== v);
    return this;
  }
  in(c: string, vs: unknown[]) {
    this.filters.push((r) => vs.includes(r[c]));
    return this;
  }
  gte(c: string, v: string) {
    this.filters.push((r) => String(r[c] ?? "") >= v);
    return this;
  }
  lte(c: string, v: string) {
    this.filters.push((r) => String(r[c] ?? "") <= v);
    return this;
  }
  is(c: string, v: unknown) {
    this.filters.push((r) => (r[c] ?? null) === v);
    return this;
  }
  not() {
    return this;
  }
  or() {
    return this;
  }
  order() {
    return this;
  }
  limit(n: number) {
    this.lim = n;
    return this;
  }
  then<A, B>(ok?: ((v: { data: unknown; error: null; count?: number }) => A) | null, bad?: ((e: unknown) => B) | null) {
    if (this.op === "insert") {
      const row = { id: `${this.table}-${(db[this.table] ?? []).length + 1}`, ...this.patch };
      (db[this.table] ??= []).push(row);
      return Promise.resolve({ data: this.single ? row : [row], error: null }).then(ok, bad);
    }
    const rows = (db[this.table] ?? []).filter((r) => this.filters.every((f) => f(r)));
    if (this.op === "update") {
      for (const r of rows) Object.assign(r, this.patch);
      return Promise.resolve({ data: rows, error: null }).then(ok, bad);
    }
    const out = rows.slice(0, this.lim);
    return Promise.resolve({ data: this.head ? null : this.single ? (out[0] ?? null) : out, error: null, count: rows.length }).then(ok, bad);
  }
}

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (t: string) => new Query(t),
    rpc: async (fn: string, args: Row) => {
      rpcCalls.push({ fn, args });
      if (fn === "update_goal_progress") {
        for (const g of db.autopilot_goals ?? []) {
          if (g.id === args.p_goal_id && g.tenant_id === args.p_tenant_id) g.current_value = args.p_current_value;
        }
      }
      if (fn === "write_autopilot_goal" && args.p_op === "update") {
        const g = (db.autopilot_goals ?? []).find(
          (r) =>
            r.id === args.p_goal_id &&
            r.tenant_id === args.p_tenant_id &&
            Object.entries((args.p_expect as Row | null) ?? {}).every(([k, v]) => (r[k] ?? null) === (v ?? null)),
        );
        if (g) Object.assign(g, args.p_values as Row);
        return { data: g ? { status: "written", id: g.id } : { status: "not_matched", id: null }, error: null };
      }
      return { data: null, error: null };
    },
  }),
}));
vi.mock("@/services/agents/visibility", () => ({ getVisibleAgentSlugs: async () => new Set(["research"]) }));
vi.mock("@/services/settings", () => ({ getBoolSettingStrictResolved: async () => false }));
vi.mock("@/services/agents/runner", () => ({ enqueueAgentRun: vi.fn() }));

import { applyGoalMoves, type GoalMoves } from "../goal-owner";
import { schemaHashFor, type CountDeps } from "../goal-count-rule";
import { countAsk, countRuleAsks, expiredNumberAsk } from "../goal-count-review";
import type { OperatorDbCatalog } from "@/services/tools/operator-db/types";

const T = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const G1 = "95c06147-0000-4000-8000-000000000000";
const NOW = new Date("2026-09-28T12:00:00Z");
const on = { kind: "scheduled" as const, alarm_keys: [], autopilot: true };
const reply = { ...on, kind: "founder" as const, reply_via: "email" as const };

const catalog: OperatorDbCatalog = {
  tables: [{ name: "cars", rowEstimate: 3676, columns: [{ name: "ownerId", type: "string", nullable: false }] }],
};
const HOSTS = {
  goal_id: G1,
  definition: "hosts who ever listed a car, any listing status",
  dialect: "mongodb" as const,
  collection: "cars",
  pipeline: [{ $group: { _id: "$ownerId" } }, { $count: "n" }],
};
const HASH = schemaHashFor(catalog, { dialect: "mongodb", collection: HOSTS.collection, pipeline: HOSTS.pipeline })!;

let count: { rows: Row[]; truncated: boolean } | Error = { rows: [{ n: 1522 }], truncated: false };
let liveCatalog: OperatorDbCatalog = catalog;
const reads: string[] = [];
const catalogReads: string[] = [];
const countDeps: CountDeps = {
  catalog: async (t) => (catalogReads.push(t), { dialect: "mongodb", catalog: liveCatalog, discovery_error: null }),
  mongoAggregate: async (t) => {
    reads.push(t);
    if (count instanceof Error) throw count;
    return count as { rows: Array<Record<string, unknown>>; truncated: boolean };
  },
  sqlRead: async () => {
    throw new Error("no sql here");
  },
};

function hostsGoal(over: Row = {}): Row {
  return {
    id: G1,
    tenant_id: T,
    objective: "Grow hosts to 2,000",
    target_metric: "total_hosts",
    target_value: 2000,
    current_value: 612,
    current_value_at: "2026-09-08T20:11:00Z",
    due_date: "2026-12-31",
    status: "active",
    priority: 50,
    measurement_mode: "manual_reported",
    ...over,
  };
}
const review = (extra: Partial<GoalMoves> = {}): GoalMoves => ({ goals: [], goal_changes: [], channel_changes: [], ...extra });
const deps = (meta: typeof on | typeof reply) => ({
  emitDecision: vi.fn(async () => "d-1"),
  resolveRepo: async () => null,
  adBudget: async () => null,
  countDeps,
  now: NOW,
  meta,
});

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  Object.assign(db, { autopilot_goals: [], decisions: [], agent_runs: [], cgo_notes: [], cgo_questions: [] });
  db.tenant_subscriptions = [{ tenant_id: T, tier: "starter", status: "active", comp_expires_at: null }];
  rpcCalls.length = 0;
  reads.length = 0;
  catalogReads.length = 0;
  count = { rows: [{ n: 1522 }], truncated: false };
  liveCatalog = catalog;
});

describe("propose -> dry run -> question", () => {
  it("a proposed rule is dry-run on the tenant's own DB and asked with today's count", async () => {
    db.autopilot_goals.push(hostsGoal());
    await applyGoalMoves(T, "run-1", review({ goal_count_rules: [HOSTS] }), deps(on));
    const q = db.cgo_questions.find((x) => String(x.topic_key).startsWith(`count:${G1}:`))!;
    expect(q.ask).toBe('I\'ll count "Grow hosts to 2,000" as hosts who ever listed a car, any listing status. Today that is 1,522. Use this?');
    expect(q.ask).toBe(countAsk("Grow hosts to 2,000", HOSTS.definition, 1522));
    expect(q.default_action).toBeNull();
    expect(q.count_rule).toMatchObject({ goal_id: G1, dialect: "mongodb", collection: "cars", schema_hash: HASH, source: "operator_db" });
    expect(db.autopilot_goals[0].count_rule).toBeUndefined();
    expect(db.autopilot_goals[0].current_value).toBe(612);
    expect(new Set([...reads, ...catalogReads])).toEqual(new Set([T]));
    expect(db.cgo_questions.some((x) => x.topic_key === `number:${G1}`)).toBe(false);
  });

  it("a dry run that is not one number asks nothing and records why", async () => {
    db.autopilot_goals.push(hostsGoal());
    count = { rows: [{ n: 1 }, { n: 2 }], truncated: false };
    await applyGoalMoves(T, "run-1", review({ goal_count_rules: [HOSTS] }), deps(on));
    expect(db.cgo_questions.some((x) => String(x.topic_key).startsWith("count:"))).toBe(false);
    expect(db.cgo_notes[0].refused).toContain('Count rule for "Grow hosts to 2,000": dry run refused (not_one_number).');
  });

  it("a SQL write is never run: refused before the DB is touched", async () => {
    db.autopilot_goals.push(hostsGoal());
    await applyGoalMoves(T, "run-1", review({ goal_count_rules: [{ goal_id: G1, definition: "hosts", dialect: "sql", query: "delete from cars" }] }), deps(on));
    expect(reads).toEqual([]);
    expect(db.cgo_questions.some((x) => String(x.topic_key).startsWith("count:"))).toBe(false);
  });

  it("a goal of another tenant is never counted", async () => {
    db.autopilot_goals.push(hostsGoal({ tenant_id: OTHER }));
    await applyGoalMoves(T, "run-1", review({ goal_count_rules: [HOSTS] }), deps(on));
    expect(reads).toEqual([]);
    expect(catalogReads).toEqual([]);
    expect(db.cgo_questions).toEqual([]);
  });
});

describe("the founder's answer", () => {
  async function asked(): Promise<string> {
    db.autopilot_goals.push(hostsGoal());
    await applyGoalMoves(T, "run-1", review({ goal_count_rules: [HOSTS] }), deps(on));
    return String(db.cgo_questions.find((x) => String(x.topic_key).startsWith("count:"))!.id);
  }

  it("yes: saves exactly the asked rule, confirmed, and writes today's count with its source", async () => {
    const qid = await asked();
    count = { rows: [{ n: 1530 }], truncated: false };
    await applyGoalMoves(T, "run-r", review({ answered: [{ question_id: qid, answer: "yes" }], count_rules_confirmed: [qid] }), deps(reply));
    const g = db.autopilot_goals[0];
    expect(g.count_rule).toMatchObject({ dialect: "mongodb", collection: "cars", definition: HOSTS.definition, schema_hash: HASH, confirmed_at: NOW.toISOString(), confirmed_by: "founder (email reply)", stale_reason: null });
    expect(g.count_rule).not.toHaveProperty("goal_id");
    expect(g).toMatchObject({ current_value: 1530, current_value_at: NOW.toISOString(), current_value_source: `counted: ${HOSTS.definition}` });
    expect(db.cgo_notes[1].changed).toContain(`Counting "Grow hosts to 2,000" every day as ${HOSTS.definition}. Today it is 1,530.`);
    expect(db.cgo_questions.some((x) => x.topic_key === `number:${G1}`)).toBe(false);
  });

  it("a confirmed count that reaches the target ends the goal in this same review", async () => {
    const qid = await asked();
    count = { rows: [{ n: 2100 }], truncated: false };
    await applyGoalMoves(T, "run-r", review({ answered: [{ question_id: qid, answer: "yes" }], count_rules_confirmed: [qid] }), deps(reply));
    expect(db.autopilot_goals[0]).toMatchObject({ current_value: 2100, status: "met", status_changed_by: "cgo" });
  });

  it("no: the question is answered, nothing is saved", async () => {
    const qid = await asked();
    await applyGoalMoves(T, "run-r", review({ answered: [{ question_id: qid, answer: "no, only active listings" }] }), deps(reply));
    expect(db.cgo_questions.find((x) => x.id === qid)!.status).toBe("answered");
    expect(db.autopilot_goals[0].count_rule).toBeUndefined();
    expect(db.autopilot_goals[0].current_value).toBe(612);
  });

  it("a yes outside a founder reply, or not answered by this reply, saves nothing", async () => {
    const qid = await asked();
    await applyGoalMoves(T, "run-x", review({ answered: [{ question_id: qid, answer: "yes" }], count_rules_confirmed: [qid] }), deps(on));
    expect(db.autopilot_goals[0].count_rule).toBeUndefined();
    await applyGoalMoves(T, "run-r", review({ count_rules_confirmed: [qid] }), deps(reply));
    expect(db.autopilot_goals[0].count_rule).toBeUndefined();
  });

  it("another tenant's question is never confirmed for this tenant", async () => {
    const qid = await asked();
    db.cgo_questions.find((x) => x.id === qid)!.tenant_id = OTHER;
    await applyGoalMoves(T, "run-r", review({ answered: [{ question_id: qid, answer: "yes" }], count_rules_confirmed: [qid] }), deps(reply));
    expect(db.autopilot_goals[0].count_rule).toBeUndefined();
    expect(db.autopilot_goals[0].current_value).toBe(612);
  });

  it("the schema changed between the ask and the yes: nothing is saved", async () => {
    const qid = await asked();
    liveCatalog = { tables: [{ name: "cars", rowEstimate: 1, columns: [{ name: "ownerId", type: "objectId", nullable: false }] }] };
    await applyGoalMoves(T, "run-r", review({ answered: [{ question_id: qid, answer: "yes" }], count_rules_confirmed: [qid] }), deps(reply));
    expect(db.autopilot_goals[0].count_rule).toBeUndefined();
  });
});

describe("numbers cgo cannot trust become questions", () => {
  const confirmed = { dialect: "mongodb", source: "operator_db", collection: "cars", pipeline: HOSTS.pipeline, definition: HOSTS.definition, schema_hash: HASH, confirmed_at: "2026-09-20T00:00:00Z", confirmed_by: "founder (email reply)" };

  it("a typed number older than 14 days: asks for a fresh one (no rule proposed)", async () => {
    db.autopilot_goals.push(hostsGoal());
    await applyGoalMoves(T, "run-1", review(), deps(on));
    const q = db.cgo_questions.find((x) => x.topic_key === `number:${G1}`)!;
    expect(q.ask).toBe(expiredNumberAsk("Grow hosts to 2,000", 612, 20, { hasDataSource: true }));
    expect(q.ask).toBe('"Grow hosts to 2,000" shows 612, which you entered 20 days ago. What is it today? Update it on the goal, or tell me how to count it from your data.');
  });

  it("with no database to count from, the same ask never asks to connect one", async () => {
    liveCatalog = { tables: [] };
    db.autopilot_goals.push(hostsGoal());
    await applyGoalMoves(T, "run-1", review(), deps(on));
    const q = db.cgo_questions.find((x) => x.topic_key === `number:${G1}`)!;
    expect(q.ask).toBe('"Grow hosts to 2,000" shows 612, which you entered 20 days ago. What is it today? Update it on the goal.');
  });

  it("a fresh typed number (under 14 days) is not asked about", async () => {
    db.autopilot_goals.push(hostsGoal({ current_value_at: "2026-09-20T00:00:00Z" }));
    await applyGoalMoves(T, "run-1", review(), deps(on));
    expect(db.cgo_questions).toEqual([]);
  });

  it("a rule stale on a schema change: re-asks with today's count under the new schema", async () => {
    liveCatalog = { tables: [{ name: "cars", rowEstimate: 1, columns: [{ name: "ownerId", type: "objectId", nullable: false }] }] };
    db.autopilot_goals.push(hostsGoal({ count_rule: { ...confirmed, stale_reason: "schema_changed", stale_at: "2026-09-28T13:30:00Z" } }));
    await applyGoalMoves(T, "run-1", review(), deps(on));
    const q = db.cgo_questions.find((x) => String(x.topic_key).startsWith(`count:${G1}:`))!;
    expect(q.ask).toContain("changed, so I stopped counting it");
    expect(q.ask).toContain("today it is 1,522");
    expect((q.count_rule as Row).schema_hash).toBe(schemaHashFor(liveCatalog, { dialect: "mongodb", collection: "cars", pipeline: HOSTS.pipeline }));
    expect(q.count_rule).not.toHaveProperty("confirmed_at");
  });

  it("a rule failing for over a day: asks how to count it now; a single blip does not", async () => {
    db.autopilot_goals.push(hostsGoal({ count_rule: { ...confirmed, stale_reason: "query_failed", stale_at: "2026-09-28T11:00:00Z" } }));
    await applyGoalMoves(T, "run-1", review(), deps(on));
    expect(db.cgo_questions).toEqual([]);
    db.autopilot_goals[0].count_rule = { ...confirmed, stale_reason: "query_failed", stale_at: "2026-09-26T13:30:00Z" };
    await applyGoalMoves(T, "run-2", review(), deps(on));
    expect(db.cgo_questions.map((x) => x.ask)).toEqual([`I couldn't count "Grow hosts to 2,000" as ${HOSTS.definition}: the count failed. How should I count it now?`]);
  });
});

describe("a near deadline asks for the number now (PLAN-cgo-deadline-pace)", () => {
  it("an expired number: never asks the founder to connect a tool", () => {
    expect(expiredNumberAsk("Reach 300 signups by Oct 30", 40, 5, { hasDataSource: false })).toBe(
      '"Reach 300 signups by Oct 30" shows 40, which you entered 5 days ago. What is it today? Update it on the goal.',
    );
    expect(expiredNumberAsk("Reach 300 signups by Oct 30", 40, 5, { hasDataSource: true })).toMatch(/tell me how to count it from your data/);
  });
});

describe("countRuleAsks: a deadline goal's number is asked for before the 14-day expiry", () => {
  const base = { tenant_id: T, proposals: [], today: "2026-10-02", now: new Date("2026-10-02T12:00:00Z"), openTopics: new Set<string>(), deps: countDeps };
  const g = (over: Row = {}) => ({ id: G1, objective: "Reach 300 signups by Oct 30", current_value: 40, current_value_at: "2026-09-27T00:00:00Z", measurement_mode: "manual_reported", ...over }) as never;
  it("a typed number too old to pace on is asked about; a fresh one is not", async () => {
    const r = await countRuleAsks({ ...base, goals: [g()], trusted: () => true, ageDays: () => 5, needsPaceNumber: () => true });
    expect(r.asks.map((a) => a.topic_key)).toEqual([`number:${G1}`]);
    const none = await countRuleAsks({ ...base, goals: [g()], trusted: () => true, ageDays: () => 1, needsPaceNumber: () => false });
    expect(none.asks).toEqual([]);
  });
  it("a goal that has never had a number is never asked for one (Ravi, 2026-10-29)", async () => {
    liveCatalog = { tables: [] };
    for (const mode of ["manual_reported", "unmapped", "auto"]) {
      const r = await countRuleAsks({ ...base, goals: [g({ measurement_mode: mode, current_value: null, current_value_at: null })], trusted: () => false, ageDays: () => null, needsPaceNumber: () => true });
      expect(r.asks).toEqual([]);
    }
  });
  it("a stale typed number is still refreshed, past the 14-day expiry with no near deadline", async () => {
    const r = await countRuleAsks({ ...base, goals: [g()], trusted: () => false, ageDays: () => 20, needsPaceNumber: () => false });
    expect(r.asks.map((a) => a.topic_key)).toEqual([`number:${G1}`]);
    expect(r.asks[0].ask).toContain("which you entered 20 days ago");
  });
  it("an automatic goal with a number is not asked about", async () => {
    const measured = await countRuleAsks({ ...base, goals: [g({ measurement_mode: "auto", current_value: 40 })], trusted: () => true, ageDays: () => 1, needsPaceNumber: () => true });
    expect(measured.asks).toEqual([]);
  });
  it("an open number question is never asked twice", async () => {
    const r = await countRuleAsks({ ...base, openTopics: new Set([`number:${G1}`]), goals: [g()], trusted: () => true, ageDays: () => 5, needsPaceNumber: () => true });
    expect(r.asks).toEqual([]);
  });
});

describe("countAsk words", () => {
  it("never reads '..', and says the number once", () => {
    const def = "October GMV is the money from paid trips booked Oct 1 to 31. Today this counts $40,438.65 across 87 trips, against the $70,000 the goal shows.";
    const ask = countAsk("GMV growth stunt.", def, 40438.65);
    expect(ask).toBe(`I'll count "GMV growth stunt" as October GMV is the money from paid trips booked Oct 1 to 31. Today this counts $40,438.65 across 87 trips, against the $70,000 the goal shows. Use this?`);
    expect(ask).not.toContain("..");
  });
  it("a number inside another number is not today's count", () => {
    expect(countAsk("Trips", "paid trips booked Oct 1 to 31", 1)).toBe(`I'll count "Trips" as paid trips booked Oct 1 to 31. Today that is 1. Use this?`);
    expect(countAsk("GMV", "money from trips, today $140,438.65", 40438.65)).toContain("Today that is 40,438.65.");
  });
  it("a small whole number is always said, even when a date in the sentence matches it", () => {
    expect(countAsk("Trips", "paid trips booked Oct 1 to 31 as of today", 31)).toContain("Today that is 31.");
    expect(countAsk("Trips", "trips booked 31/10, counted today", 31)).toContain("Today that is 31.");
  });
  it("a calendar day in a Today sentence is not the count", () => {
    expect(countAsk("Trips", "paid trips booked today, Oct 1 to 31", 1)).toContain("Today that is 1.");
    expect(countAsk("Trips", "paid trips booked today, October 1 to 31", 1)).toContain("Today that is 1.");
  });
  it("a Today sentence counts whatever the word order", () => {
    expect(countAsk("Hosts", "hosts with a live listing. There are 1,522 of them today", 1522)).toBe(`I'll count "Hosts" as hosts with a live listing. There are 1,522 of them today. Use this?`);
  });
  it("adds today's number when the definition does not say it", () => {
    expect(countAsk("Grow hosts", "hosts with a live listing", 1522)).toBe(`I'll count "Grow hosts" as hosts with a live listing. Today that is 1,522. Use this?`);
  });
});
