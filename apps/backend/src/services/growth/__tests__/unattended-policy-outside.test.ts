import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};
const failReads = new Set<string>();

function query(tid: string, table: string) {
  let rows = (tables[table] ?? []).filter((r) => r.tenant_id === tid);
  const b = {
    select: () => b,
    eq(c: string, v: unknown) {
      rows = rows.filter((r) => r[c] === v);
      return b;
    },
    in(c: string, vs: unknown[]) {
      rows = rows.filter((r) => vs.includes(r[c]));
      return b;
    },
    gte(c: string, v: string) {
      rows = rows.filter((r) => String(r[c] ?? "") >= v);
      return b;
    },
    or(expr: string) {
      const ids = [...expr.matchAll(/([\w>-]+)\.(eq|gte)\.([^,)]+)/g)].map((m) => [m[1], m[2], m[3]] as const);
      const at = (r: Row, c: string) => {
        const [col, key] = c.split("->>");
        const v = r[col];
        return key ? (v as Record<string, unknown> | null)?.[key] : v;
      };
      rows = rows.filter((r) => ids.some(([c, op, v]) => (op === "eq" ? at(r, c) === v : String(at(r, c) ?? "") >= v)));
      return b;
    },
    not: () => b,
    neq: () => b,
    is: () => b,
    order: () => b,
    limit: () => b,
    maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
    then(res: (v: { data: Row[] | null; error: { message: string } | null }) => unknown) {
      if (failReads.has(table)) return Promise.resolve({ data: null, error: { message: `${table} down` } }).then(res);
      return Promise.resolve({ data: rows, error: null }).then(res);
    },
  };
  return b;
}

vi.mock("@/services/tenant-client", async (orig) => ({
  ...(await orig<typeof import("@/services/tenant-client")>()),
  asTenantId: (t: string) => t,
  tenantClient: (tid: string) => ({ from: (t: string) => query(tid, t) }),
  tenantRpc: async () => ({ data: null, error: { message: "no rpc in this test" } }),
}));
vi.mock("../channel-autorun", async (orig) => ({ ...(await orig<typeof import("../channel-autorun")>()), readEffectiveAutorun: async () => true }));
vi.mock("@/services/tools/meta-ads/_client", () => ({
  fbGet: async () => {
    throw new Error("no Meta in this test");
  },
}));

import { evaluateUnattended, loadUnattendedFacts, type UnattendedAction } from "../unattended-policy";

const T = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-05T12:00:00Z");
const resume: UnattendedAction = {
  kind: "ad",
  exec_class: "meta_ads.set_status_review",
  payload: { object_id: "120000000000001", level: "adset", status: "ACTIVE", over_cap: false, name: "40% to Turo" },
  source: { table: "channel_actions", id: "act-9", run_id: null },
};
const raise: UnattendedAction = {
  kind: "ad",
  exec_class: "meta_ads.update_ad_set_budget",
  payload: { ad_set_id: "120000000000001", daily_budget_usd: 60, expected_current_daily_budget_usd: 40, over_cap: false, name: "40% to Turo" },
  source: { table: "channel_actions", id: "act-10", run_id: null },
};
const outside = (over: Row): Row => ({
  tenant_id: T,
  platform: "meta",
  object_id: "120000000000001",
  campaign_id: "c1",
  source: "outside",
  change_kind: "status",
  before_status: "ACTIVE",
  after_status: "PAUSED",
  occurred_at: "2026-10-04T10:00:00Z",
  ...over,
});

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  failReads.clear();
});

describe("R4 + decision 6: a resume of an object paused outside Zavi goes to the founder", () => {
  it("cgo paused it, then the founder paused it again by hand: founder's pause -> ask_founder", async () => {
    tables.channel_actions = [
      { tenant_id: T, exec_class: "meta_ads.set_status", exec_status: "executed", executed_at: "2026-10-01T10:00:00Z", approved_by_source: "cgo", exec_payload: { object_id: "120000000000001", status: "PAUSED" } },
      { tenant_id: T, exec_class: "meta_ads.set_status_review", exec_status: "executed", executed_at: "2026-10-02T10:00:00Z", approved_by_source: "cgo", exec_payload: { object_id: "120000000000001", status: "ACTIVE" } },
    ];
    tables.ad_object_changes = [outside({})];
    const f = await loadUnattendedFacts(T, resume, { now: NOW });
    expect(f.pausedByFounder).toBe(true);
    const v = evaluateUnattended(resume, { ...f, objects: [{ id: "1", conversionObjective: true, objective: null, learning: false, daysSinceEdit: 30, lockDays: 7, spend7dUsd: 100, conversions7d: 3, targetCpaUsd: null }], goal: { present: false }, openAdvice: "clear", refsResolved: true });
    expect(v.verdict).toBe("ask_founder");
    expect(v.reasons).toContain("founder_paused_it");
  });

  it("an outside pause of its CAMPAIGN counts for the ad set too", async () => {
    tables.ad_object_changes = [outside({ object_id: "as-other", campaign_id: "120000000000001" })];
    expect((await loadUnattendedFacts(T, resume, { now: NOW })).pausedByFounder).toBe(true);
  });

  it("cgo's own pause is still cgo's (resume allowed), and another tenant's outside rows change nothing", async () => {
    tables.channel_actions = [
      { tenant_id: T, exec_class: "meta_ads.set_status", exec_status: "executed", executed_at: "2026-10-04T11:00:00Z", approved_by_source: "cgo", exec_payload: { object_id: "120000000000001", status: "PAUSED" } },
    ];
    tables.ad_object_changes = [{ ...outside({ occurred_at: "2026-10-05T11:00:00Z" }), tenant_id: OTHER }];
    expect((await loadUnattendedFacts(T, resume, { now: NOW })).pausedByFounder).toBe(false);
  });

  it("an unreadable outside log is 'who paused it: unknown' (ask), never cgo's", async () => {
    tables.channel_actions = [
      { tenant_id: T, exec_class: "meta_ads.set_status", exec_status: "executed", executed_at: "2026-10-04T11:00:00Z", approved_by_source: "cgo", exec_payload: { object_id: "120000000000001", status: "PAUSED" } },
    ];
    failReads.add("ad_object_changes");
    expect((await loadUnattendedFacts(T, resume, { now: NOW })).pausedByFounder).toBeNull();
  });
});

describe("decision 6: a budget the founder set outside Zavi", () => {
  it("is read for a budget change (last 30 days, this tenant): true, false, or null when unreadable", async () => {
    tables.ad_object_changes = [outside({ change_kind: "budget", occurred_at: "2026-09-20T00:00:00Z" })];
    expect((await loadUnattendedFacts(T, raise, { now: NOW })).founderSetBudget).toBe(true);
    tables.ad_object_changes = [outside({ change_kind: "budget", occurred_at: "2026-08-01T00:00:00Z" }), { ...outside({ change_kind: "budget" }), tenant_id: OTHER }];
    expect((await loadUnattendedFacts(T, raise, { now: NOW })).founderSetBudget).toBe(false);
    failReads.add("ad_object_changes");
    expect((await loadUnattendedFacts(T, raise, { now: NOW })).founderSetBudget).toBeNull();
  });
});

describe("bug #4: a budget the founder approved in Zavi is theirs too (Autopilot does not undo it)", () => {
  const AS = "120000000000001";
  const tapped = (over: Row = {}): Row => ({
    id: "d-f1",
    tenant_id: T,
    decision_class: "meta_ads.update_ad_set_budget_review",
    status: "acted",
    approved_at: "2026-10-01T00:00:00Z",
    approved_by: "user-owner",
    approved_by_source: null,
    body: { ad_set_id: AS, daily_budget_usd: 50, expected_current_daily_budget_usd: 40 },
    ...over,
  });
  const card = (over: Row = {}): Row => ({
    id: "act-f1",
    tenant_id: T,
    exec_class: "meta_ads.update_ad_set_budget",
    exec_status: "executed",
    executed_at: "2026-10-01T00:00:00Z",
    approved_by: "user-owner",
    approved_by_source: null,
    exec_payload: { ad_set_id: AS, daily_budget_usd: 50, expected_current_daily_budget_usd: 40 },
    ...over,
  });
  const cut: UnattendedAction = { ...raise, payload: { ad_set_id: AS, daily_budget_usd: 20, expected_current_daily_budget_usd: 50, over_cap: false } };
  beforeEach(() => {
    tables.tenant_users = [
      { tenant_id: T, user_id: "user-owner", role: "owner" },
      { tenant_id: T, user_id: "user-member", role: "member" },
    ];
  });

  it("must-not-touch: a member's tap on a budget card is not the founder setting it", async () => {
    tables.decisions = [tapped({ approved_by: "user-member" })];
    tables.channel_actions = [card({ approved_by: "user-member" })];
    expect((await loadUnattendedFacts(T, cut, { now: NOW })).founderSetBudget).toBe(false);
  });

  it("a queued tap counts only while the card is recent; an unreadable role is null (ask)", async () => {
    tables.channel_actions = [card({ exec_status: "queued", executed_at: null, proposed_at: "2026-08-01T00:00:00Z" })];
    expect((await loadUnattendedFacts(T, cut, { now: NOW })).founderSetBudget).toBe(false);
    tables.channel_actions = [card({ exec_status: "queued", executed_at: null, proposed_at: "2026-10-04T00:00:00Z" })];
    expect((await loadUnattendedFacts(T, cut, { now: NOW })).founderSetBudget).toBe(true);
    failReads.add("tenant_users");
    expect((await loadUnattendedFacts(T, cut, { now: NOW })).founderSetBudget).toBeNull();
  });

  it("must-catch: the founder's own tap on a budget card (decisions or channel card, in flight or done) makes it founder-set, so cgo's cut asks", async () => {
    for (const status of ["acted", "approved", "dispatching", "dispatch_failed"]) {
      tables.decisions = [tapped({ status })];
      expect((await loadUnattendedFacts(T, cut, { now: NOW })).founderSetBudget, status).toBe(true);
    }
    tables.decisions = [];
    for (const exec_status of ["executed", "queued", "dispatching"]) {
      tables.channel_actions = [card({ exec_status, proposed_at: "2026-10-01T00:00:00Z" })];
      expect((await loadUnattendedFacts(T, cut, { now: NOW })).founderSetBudget, exec_status).toBe(true);
    }
    tables.channel_actions = [card({ approved_by_source: "founder" })];
    const f = await loadUnattendedFacts(T, cut, { now: NOW });
    expect(f.founderSetBudget).toBe(true);
    expect(evaluateUnattended(cut, { ...f, objects: [{ id: AS, conversionObjective: true, objective: null, learning: false, daysSinceEdit: 30, lockDays: 7, spend7dUsd: 100, conversions7d: 3, targetCpaUsd: null }], goal: { present: false }, openAdvice: "clear", refsResolved: true, trackingOk: true }).reasons).toContain("founder_set_budget|approved|2026-10-01|meta|up");
  });

  it("must-not-touch: Autopilot's, staff's or the system's approvals, an agent's auto change, another object, a definite failure, another tenant or an old tap do not count", async () => {
    tables.decisions = [
      tapped({ approved_by_source: "cgo" }),
      tapped({ approved_by_source: "staff" }),
      tapped({ approved_by_source: "plan_autopilot" }),
      tapped({ approved_by_source: "system" }),
      tapped({ approved_by: null }),
      tapped({ body: { ad_set_id: "120000000000002", daily_budget_usd: 50, expected_current_daily_budget_usd: 40 } }),
      tapped({ tenant_id: OTHER }),
      tapped({ approved_at: "2026-08-01T00:00:00Z" }),
      tapped({ status: "rejected" }),
    ];
    tables.channel_actions = [
      card({ approved_by_source: "cgo" }),
      card({ exec_status: "failed", exec_result: { bucket: "blocked_on_us" } }),
      card({ executed_at: "2026-08-01T00:00:00Z" }),
      card({ approved_by: null }),
    ];
    expect((await loadUnattendedFacts(T, cut, { now: NOW })).founderSetBudget).toBe(false);
  });

  it("an unreadable history of the founder's taps is null (ask), never 'not the founder's'", async () => {
    failReads.add("channel_actions");
    expect((await loadUnattendedFacts(T, cut, { now: NOW })).founderSetBudget).toBeNull();
  });
});

describe("GS05 spacing: the 24-hour raise history is read from Zavi's executed changes", () => {
  const AS = "120000000000001";
  const executedRaise = (over: Row = {}): Row => ({
    id: "act-1",
    tenant_id: T,
    exec_class: "meta_ads.update_ad_set_budget_review",
    exec_status: "executed",
    executed_at: "2026-10-05T11:50:00Z",
    approved_by_source: "cgo",
    exec_payload: { ad_set_id: AS, daily_budget_usd: 60, expected_current_daily_budget_usd: 30 },
    ...over,
  });
  const facts = (f: Awaited<ReturnType<typeof loadUnattendedFacts>>) => ({
    ...f,
    objects: [{ id: AS, conversionObjective: true, objective: null, learning: false, daysSinceEdit: 30, lockDays: 7, spend7dUsd: 100, conversions7d: 3, targetCpaUsd: null }],
    goal: { present: false as const },
    openAdvice: "clear" as const,
    refsResolved: true,
    trackingOk: true,
    founderSetBudget: false,
  });

  it("a chained second raise within 24 hours (30 -> 60 executed ten minutes ago) goes to the founder", async () => {
    tables.channel_actions = [executedRaise()];
    const f = await loadUnattendedFacts(T, raise, { now: NOW });
    expect(f.zaviRaisedRecently).toBe(true);
    const v = evaluateUnattended(raise, facts(f));
    expect(v.verdict).toBe("ask_founder");
    expect(v.reasons).toContain("raised_in_last_day");
  });

  it("an in-flight raise and a raise on the legacy decisions rail count too; any approver counts", async () => {
    tables.channel_actions = [executedRaise({ exec_status: "dispatching", executed_at: null, exec_claimed_at: "2026-10-05T11:59:00Z", approved_by_source: null })];
    expect((await loadUnattendedFacts(T, raise, { now: NOW })).zaviRaisedRecently).toBe(true);
    tables.channel_actions = [];
    tables.decisions = [{ id: "d-1", tenant_id: T, decision_class: "meta_ads.update_ad_set_budget", status: "acted", dispatched_at: "2026-10-05T01:00:00Z", body: { ad_set_id: AS, daily_budget_usd: 60, expected_current_daily_budget_usd: 30 } }];
    expect((await loadUnattendedFacts(T, raise, { now: NOW })).zaviRaisedRecently).toBe(true);
  });

  it("a raise more than 24 hours ago, a cut, another object, a definite failure, another tenant, and the row itself do not count: within 2x it is the CGO's", async () => {
    tables.channel_actions = [
      executedRaise({ executed_at: "2026-10-04T11:59:00Z" }),
      executedRaise({ exec_payload: { ad_set_id: AS, daily_budget_usd: 20, expected_current_daily_budget_usd: 30 } }),
      executedRaise({ exec_payload: { ad_set_id: "120000000000002", daily_budget_usd: 60, expected_current_daily_budget_usd: 30 } }),
      executedRaise({ exec_status: "failed", exec_result: { bucket: "blocked_on_us", code: "meta_100_1" } }),
      executedRaise({ tenant_id: OTHER }),
      executedRaise({ id: "act-10", exec_status: "dispatching", executed_at: null, exec_claimed_at: "2026-10-05T11:59:00Z" }),
    ];
    const f = await loadUnattendedFacts(T, raise, { now: NOW });
    expect(f.zaviRaisedRecently).toBe(false);
    expect(evaluateUnattended(raise, facts(f)).verdict).toBe("allow");
  });

  it("a failure that may have landed still counts, on either rail", async () => {
    tables.channel_actions = [executedRaise({ exec_status: "failed", exec_result: { bucket: "temporary" } })];
    expect((await loadUnattendedFacts(T, raise, { now: NOW })).zaviRaisedRecently).toBe(true);
    tables.channel_actions = [];
    tables.decisions = [{ id: "d-2", tenant_id: T, decision_class: "meta_ads.update_ad_set_budget", status: "dispatch_failed", dispatched_at: "2026-10-05T11:00:00Z", body: { ad_set_id: AS, daily_budget_usd: 60, expected_current_daily_budget_usd: 30 } }];
    expect((await loadUnattendedFacts(T, raise, { now: NOW })).zaviRaisedRecently).toBe(true);
  });

  it("an approved raise not yet sent counts: a queued card, or an approved decision", async () => {
    tables.channel_actions = [executedRaise({ exec_status: "queued", executed_at: null })];
    expect((await loadUnattendedFacts(T, raise, { now: NOW })).zaviRaisedRecently).toBe(true);
    tables.channel_actions = [];
    tables.decisions = [{ id: "d-3", tenant_id: T, decision_class: "meta_ads.update_ad_set_budget_review", status: "approved", approved_at: "2026-10-05T11:30:00Z", body: { ad_set_id: AS, daily_budget_usd: 60, expected_current_daily_budget_usd: 30 } }];
    expect((await loadUnattendedFacts(T, raise, { now: NOW })).zaviRaisedRecently).toBe(true);
  });

  it("an unreadable history is null and goes to the founder", async () => {
    failReads.add("decisions");
    const f = await loadUnattendedFacts(T, raise, { now: NOW });
    expect(f.zaviRaisedRecently).toBeNull();
    const v = evaluateUnattended(raise, facts(f));
    expect(v.verdict).toBe("ask_founder");
    expect(v.reasons).toContain("raise_history_unknown");
  });

  it("is not read for a cut", async () => {
    const cut: UnattendedAction = { ...raise, payload: { ad_set_id: AS, daily_budget_usd: 20, expected_current_daily_budget_usd: 40, over_cap: false } };
    expect((await loadUnattendedFacts(T, cut, { now: NOW })).zaviRaisedRecently).toBeUndefined();
  });
});
