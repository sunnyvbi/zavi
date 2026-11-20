
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const db = { decisions: [] as Row[], channel_actions: [] as Row[], agent_runs: [] as Row[], error: null as null | { message: string } };

const runView = (r: Row): Row => {
  const p = (r.payload ?? {}) as Row;
  return { ...r, thread: p.thread_id ?? null, resume_of: p.resume_of_run_id ?? null, ref_run: (p.founder_message_ref as Row | undefined)?.run_id ?? null };
};

function query(table: keyof typeof db) {
  const filters: Array<(r: Row) => boolean> = [];
  const decisionView = (r: Row): Row => ({ ...r, founder: (r.body as Row | null)?.founder_chat_order === true ? "true" : null });
  const rows = (): Row[] =>
    table === "agent_runs" ? (db.agent_runs as Row[]).map(runView) : table === "decisions" ? (db.decisions as Row[]).map(decisionView) : (db[table] as Row[]);
  const get = (r: Row, col: string): unknown => {
    const m = /^(\w+)->>(\w+)$/.exec(col);
    if (m) return (r[m[1]] as Row | null)?.[m[2]];
    return r[col];
  };
  const self = {
    select: () => self,
    eq: (col: string, val: unknown) => (filters.push((r) => get(r, col) === val), self),
    in: (col: string, vals: unknown[]) => (filters.push((r) => vals.includes(get(r, col))), self),
    neq: (col: string, val: unknown) => (filters.push((r) => get(r, col) !== val), self),
    gte: () => self,
    limit: () => self,
    maybeSingle: async () => ({ data: rows().filter((r) => filters.every((f) => f(r)))[0] ?? null, error: db.error }),
    then: (resolve: (v: unknown) => unknown) => resolve({ data: rows().filter((r) => filters.every((f) => f(r))), error: db.error }),
  };
  return self;
}

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantClient: () => ({ from: (t: keyof typeof db) => query(t) }),
}));

import {
  mayResumeRun,
  checkPairedLeg,
  cutStillHolds,
  legSide,
  moveGroupOf,
  orderQuiescent,
  pairVerdict,
  pairedDispatchHold,
  type LiveReader,
  type MoveLeg,
} from "../move-group";

const T = "tenant-1";
const ROOT = "run-root";
const founder = (extra: Row) => ({ founder_chat_order: true, origin: "user_initiated_chat", move_group: ROOT, ...extra });
const RAISE = founder({ ad_set_id: "111", daily_budget_usd: 50, expected_current_daily_budget_usd: 40 });
const CUT = founder({ campaign_id: "222", daily_budget_usd: 10, expected_current_daily_budget_usd: 20 });

function decision(id: string, cls: string, body: Row, status: string, run = ROOT): Row {
  return { id, tenant_id: T, decision_class: cls, body, status, agent_run_id: run };
}

const live = (over: Partial<LiveReader> = {}): LiveReader => ({
  googleCampaign: async () => ({ daily_usd: 10, status: "ENABLED" }),
  googleAdGroupStatus: async () => "PAUSED",
  googleAdStatus: async () => "PAUSED",
  metaObject: async () => ({ daily: 10, status: "PAUSED" }),
  ...over,
});

beforeEach(() => {
  db.decisions = [];
  db.channel_actions = [];
  db.agent_runs = [{ id: ROOT, tenant_id: T, status: "success", enqueued_at: "2026-10-18T04:13:58Z", payload: { thread_id: "th-1" } }];
  db.error = null;
});

describe("the incident: a founder's Meta raise and Google cut", () => {
  beforeEach(() => {
    db.decisions = [
      decision("raise", "meta_ads.update_ad_set_budget_review", RAISE, "proposed"),
      decision("cut", "google_ads.update_campaign_budget_review", CUT, "proposed"),
    ];
  });

  it("the raise cannot be approved while the cut is untapped", async () => {
    expect(await checkPairedLeg(T, { id: "raise", exec_class: "meta_ads.update_ad_set_budget_review", body: RAISE })).toMatchObject({ kind: "wait", why: "cut_untapped" });
  });

  it("the cut can always be approved (a cut is not a raise)", async () => {
    expect(await checkPairedLeg(T, { id: "cut", exec_class: "google_ads.update_campaign_budget_review", body: CUT })).toEqual({ kind: "go" });
  });

  it.each([
    ["approved", "cut_applying"],
    ["dispatching", "cut_applying"],
    ["dispatch_failed", "cut_failed"],
    ["rejected", "cut_declined"],
    ["expired", "cut_declined"],
    ["superseded", "cut_declined"],
  ])("the raise still waits while the cut is %s", async (status, why) => {
    db.decisions[1].status = status;
    expect(await checkPairedLeg(T, { id: "raise", exec_class: "meta_ads.update_ad_set_budget_review", body: RAISE })).toMatchObject({ kind: "wait", why });
  });

  it("the raise goes once the cut applied and the order stopped filing", async () => {
    db.decisions[1].status = "acted";
    expect(await checkPairedLeg(T, { id: "raise", exec_class: "meta_ads.update_ad_set_budget_review", body: RAISE })).toEqual({ kind: "go" });
  });

  it("the executor holds the raise when the applied cut was put back up in the account", async () => {
    db.decisions[1].status = "acted";
    const wait = await pairedDispatchHold(T, { id: "raise", exec_class: "meta_ads.update_ad_set_budget_review", body: RAISE }, live({ googleCampaign: async () => ({ daily_usd: 20, status: "ENABLED" }) }));
    expect(wait).toMatch(/no longer in place/);
    expect(await pairedDispatchHold(T, { id: "raise", exec_class: "meta_ads.update_ad_set_budget_review", body: RAISE }, live())).toBeNull();
  });

  it("the executor holds the raise when the cut's live state cannot be read", async () => {
    db.decisions[1].status = "acted";
    const wait = await pairedDispatchHold(T, { id: "raise", exec_class: "meta_ads.update_ad_set_budget_review", body: RAISE }, live({ googleCampaign: async () => Promise.reject(new Error("down")) }));
    expect(wait).not.toBeNull();
  });

  it("legs split across both tables pair the same way", async () => {
    db.decisions = [decision("raise", "meta_ads.update_ad_set_budget_review", RAISE, "proposed")];
    db.channel_actions = [{ id: "cut-card", tenant_id: T, exec_class: "google_ads.update_campaign_budget", exec_payload: CUT, status: "pending", exec_status: null, run_id: "run-child" }];
    expect(await checkPairedLeg(T, { id: "raise", exec_class: "meta_ads.update_ad_set_budget_review", body: RAISE })).toMatchObject({ kind: "wait", why: "cut_untapped" });
    db.channel_actions[0].exec_status = "executed";
    expect(await checkPairedLeg(T, { id: "raise", exec_class: "meta_ads.update_ad_set_budget_review", body: RAISE })).toEqual({ kind: "go" });
  });

  it("a group read that fails keeps the raise waiting (fail closed)", async () => {
    db.error = { message: "down" };
    expect(await checkPairedLeg(T, { id: "raise", exec_class: "meta_ads.update_ad_set_budget_review", body: RAISE })).toMatchObject({ kind: "wait", why: "unreadable" });
    expect(await pairedDispatchHold(T, { id: "raise", exec_class: "meta_ads.update_ad_set_budget_review", body: RAISE }, live())).not.toBeNull();
  });
});

describe("a raise tapped before the order filed its cut", () => {
  it("waits while a run of the order is still going, so a later cut cannot be left behind", async () => {
    db.decisions = [decision("raise", "meta_ads.update_ad_set_budget_review", RAISE, "proposed")];
    db.agent_runs.push({ id: "child", tenant_id: T, status: "queued", payload: { founder_message_ref: { kind: "chat", run_id: ROOT } } });
    expect(await checkPairedLeg(T, { id: "raise", exec_class: "meta_ads.update_ad_set_budget_review", body: RAISE })).toMatchObject({ kind: "wait", why: "order_still_running" });
  });

  it("a fresh founder turn in the same thread is the next order and does not hold it", () => {
    expect(orderQuiescent({ root: ROOT, rootThread: "th-1", legRuns: [ROOT], active: [{ id: "next-turn", status: "running", thread: "th-1", resume_of: null, ref_run: null }] })).toBe(true);
  });

  it("a resume of the order (in its thread, or of a leg's run) holds it", () => {
    expect(orderQuiescent({ root: ROOT, rootThread: "th-1", legRuns: [ROOT], active: [{ id: "resume", status: "queued", thread: "th-1", resume_of: "older", ref_run: null }] })).toBe(false);
    expect(orderQuiescent({ root: ROOT, rootThread: null, legRuns: ["leg-run"], active: [{ id: "resume", status: "queued", thread: null, resume_of: "leg-run", ref_run: null }] })).toBe(false);
  });

  it("the run paused on THIS card does not deadlock it; any other paused run of the order holds it", () => {
    const paused = { id: ROOT, status: "paused_awaiting_approval", thread: "th-1", resume_of: null, ref_run: null };
    expect(orderQuiescent({ root: ROOT, rootThread: "th-1", legRuns: [ROOT], active: [paused], selfRun: ROOT })).toBe(true);
    expect(orderQuiescent({ root: ROOT, rootThread: "th-1", legRuns: [ROOT], active: [paused], selfRun: "another" })).toBe(false);
  });

  it("the raise's own run paused on ANOTHER card holds it until that card is decided", async () => {
    db.decisions = [
      decision("raise", "meta_ads.update_ad_set_budget_review", RAISE, "proposed"),
      decision("other", "slack.post_message", { text: "x" }, "proposed"),
    ];
    db.agent_runs[0].status = "paused_awaiting_approval";
    expect(await checkPairedLeg(T, { id: "raise", exec_class: "meta_ads.update_ad_set_budget_review", body: RAISE })).toMatchObject({ kind: "wait", why: "order_waits_on_card" });
    db.decisions[1].status = "acted";
    db.decisions[1].dispatched_at = new Date().toISOString();
    expect(await checkPairedLeg(T, { id: "raise", exec_class: "meta_ads.update_ad_set_budget_review", body: RAISE })).toMatchObject({ kind: "wait", why: "order_waits_on_card" });
    db.agent_runs[0].status = "resume_resolved";
    db.agent_runs.push({ id: "cont", tenant_id: T, status: "success", payload: { thread_id: "th-1", resume_of_run_id: ROOT } });
    expect(await checkPairedLeg(T, { id: "raise", exec_class: "meta_ads.update_ad_set_budget_review", body: RAISE })).toEqual({ kind: "go" });
  });

  it("a run paused only alongside other founder ad cards (which never resume it) does not hold the raise", async () => {
    db.decisions = [
      decision("raise", "meta_ads.update_ad_set_budget_review", RAISE, "proposed"),
      decision("cut", "google_ads.update_campaign_budget_review", CUT, "acted"),
    ];
    db.agent_runs[0].status = "paused_awaiting_approval";
    expect(await checkPairedLeg(T, { id: "raise", exec_class: "meta_ads.update_ad_set_budget_review", body: RAISE })).toEqual({ kind: "go" });
  });
});

describe("what is not a paired move is untouched", () => {
  it("an Autopilot or agent card (no founder mark) is never grouped, whatever its body says", async () => {
    const body = { ad_set_id: "111", daily_budget_usd: 50, expected_current_daily_budget_usd: 40, move_group: ROOT };
    expect(moveGroupOf(body)).toBeNull();
    expect(await checkPairedLeg(T, { id: "x", exec_class: "meta_ads.update_ad_set_budget", body })).toEqual({ kind: "go" });
  });

  it("a founder's raise with no other leg goes once the order stopped filing", async () => {
    db.decisions = [decision("raise", "meta_ads.update_ad_set_budget_review", RAISE, "proposed")];
    expect(await checkPairedLeg(T, { id: "raise", exec_class: "meta_ads.update_ad_set_budget_review", body: RAISE })).toEqual({ kind: "go" });
  });

  it("two raises in one order do not wait on each other", () => {
    const legs: MoveLeg[] = [
      { table: "decisions", id: "a", exec_class: "meta_ads.update_ad_set_budget_review", body: RAISE, state: "open", run_id: ROOT },
      { table: "decisions", id: "b", exec_class: "google_ads.update_campaign_budget_review", body: founder({ campaign_id: "9", daily_budget_usd: 30, expected_current_daily_budget_usd: 20 }), state: "open", run_id: ROOT },
    ];
    expect(pairVerdict("a", legs, true)).toEqual({ kind: "go" });
  });
});

describe("legSide: which way a leg moves spend", () => {
  it.each([
    ["meta_ads.update_ad_set_budget_review", { daily_budget_usd: 50, expected_current_daily_budget_usd: 40 }, "adds"],
    ["google_ads.update_campaign_budget_review", { daily_budget_usd: 10, expected_current_daily_budget_usd: 20 }, "lowers"],
    ["google_ads.update_campaign_budget_review", { daily_budget_usd: 10 }, "adds"],
    ["google_ads.set_status_review", { status: "PAUSED" }, "lowers"],
    ["google_ads.set_status_review", { status: "ENABLED" }, "adds"],
    ["meta_ads.set_status_review", { status: "ACTIVE" }, "adds"],
    ["meta_ads.update_ad", { ad_id: "1", status: "ACTIVE" }, "adds"],
    ["meta_ads.update_ad", { ad_id: "1", status: "PAUSED" }, "lowers"],
    ["google_ads.create_campaign", { daily_budget_usd: 20 }, "adds"],
    ["google_ads.add_keywords", { negative: true }, "neutral"],
  ] as const)("%s %j is %s", (cls, body, side) => {
    expect(legSide(cls, founder(body))).toBe(side);
  });

  it("a leg it cannot call a raise (a negative keyword) still goes before the raise", () => {
    const legs: MoveLeg[] = [
      { table: "decisions", id: "raise", exec_class: "meta_ads.update_ad_set_budget_review", body: RAISE, state: "open", run_id: ROOT },
      { table: "decisions", id: "kw", exec_class: "google_ads.add_keywords", body: founder({ negative: true }), state: "open", run_id: ROOT },
    ];
    expect(pairVerdict("raise", legs, true)).toMatchObject({ kind: "wait", why: "cut_untapped" });
  });
});

describe("cutStillHolds", () => {
  it("reads each kind of cut live", async () => {
    expect(await cutStillHolds(T, { exec_class: "meta_ads.set_status_review", body: { object_id: "1", status: "PAUSED" } }, live())).toBe(true);
    expect(await cutStillHolds(T, { exec_class: "meta_ads.set_status_review", body: { object_id: "1", status: "PAUSED" } }, live({ metaObject: async () => ({ daily: 10, status: "ACTIVE" }) }))).toBe(false);
    expect(await cutStillHolds(T, { exec_class: "google_ads.set_status", body: { level: "ad_group", campaign_id: "1", ad_group_id: "2", status: "PAUSED" } }, live())).toBe(true);
    expect(await cutStillHolds(T, { exec_class: "meta_ads.update_ad_set_budget_review", body: { ad_set_id: "1", daily_budget_usd: 10 } }, live({ metaObject: async () => ({ daily: 12, status: "ACTIVE" }) }))).toBe(false);
  });
});

describe("review fixes", () => {
  it("a cut whose live amount came back missing never counts as still in place", async () => {
    expect(await cutStillHolds(T, { exec_class: "meta_ads.update_ad_set_budget_review", body: { ad_set_id: "1", daily_budget_usd: 10 } }, live({ metaObject: async () => ({ daily: null, status: "ACTIVE" }) }))).toBe(false);
    expect(await cutStillHolds(T, { exec_class: "google_ads.update_campaign_budget_review", body: { campaign_id: "1", daily_budget_usd: 10 } }, live({ googleCampaign: async () => ({ daily_usd: null, status: "ENABLED" }) }))).toBe(false);
  });

  it("a raise in an order whose root could not be found waits; a cut in it does not", async () => {
    const g = "unknown-order:run-x";
    const raise = { ...RAISE, move_group: g };
    expect(await checkPairedLeg(T, { id: "r", exec_class: "meta_ads.update_ad_set_budget_review", body: raise })).toMatchObject({ kind: "wait", why: "order_unknown" });
    expect(await checkPairedLeg(T, { id: "c", exec_class: "google_ads.update_campaign_budget_review", body: { ...CUT, move_group: g } })).toEqual({ kind: "go" });
  });
});

describe("mayResumeRun: which other cards can still resume a paused run", () => {
  const now = new Date("2026-10-18T12:00:00Z");
  const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
  it.each([
    [{ decision_class: "slack.post_message", status: "proposed" }, true],
    [{ decision_class: "slack.post_message", status: "approved", approved_at: ago(1) }, true],
    [{ decision_class: "slack.post_message", status: "dispatching", dispatched_at: ago(1) }, true],
    [{ decision_class: "slack.post_message", status: "dispatching", dispatched_at: ago(60) }, true],
    [{ decision_class: "slack.post_message", status: "acted", dispatched_at: ago(1) }, true],
    [{ decision_class: "slack.post_message", status: "acted", dispatched_at: ago(60) }, false],
    [{ decision_class: "meta_ads.update_ad_set_budget_review", status: "acted", dispatched_at: ago(1), founder: "true" }, false],
    [{ decision_class: "meta_ads.update_ad_set_budget_review", status: "rejected", rejected_at: ago(1), founder: "true" }, true],
    [{ decision_class: "slack.post_message", status: "rejected", rejected_at: ago(60) }, false],
    [{ decision_class: "slack.post_message", status: "dispatch_failed" }, false],
    [{ decision_class: "slack.post_message", status: "superseded" }, false],
    [{ decision_class: "slack.post_message", status: "expired" }, false],
  ] as const)("%j -> %s", (o, want) => {
    expect(mayResumeRun(o, now)).toBe(want);
  });
});
