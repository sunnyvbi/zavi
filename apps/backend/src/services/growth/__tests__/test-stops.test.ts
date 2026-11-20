import { beforeEach, describe, expect, it, vi } from "vitest";

let tables: Record<string, Array<Record<string, unknown>>>;
let failing: Set<string> = new Set();
const rpc = vi.fn();
function query(table: string) {
  const filters: Array<(r: Record<string, unknown>) => boolean> = [];
  const q: Record<string, unknown> = {};
  const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
  const chain = (fn?: (r: Record<string, unknown>) => boolean) => {
    if (fn) filters.push(fn);
    return q;
  };
  q.select = () => chain();
  q.eq = (k: string, v: unknown) => chain((r) => r[k] === v);
  q.neq = (k: string, v: unknown) => chain((r) => r[k] !== v);
  q.in = (k: string, vs: unknown[]) => chain((r) => vs.includes(r[k]));
  q.is = (k: string, v: unknown) => chain((r) => (r[k] ?? null) === v);
  q.gte = (k: string, v: string) => chain((r) => String(r[k]) >= v);
  q.lte = (k: string, v: string) => chain((r) => String(r[k]) <= v);
  q.like = (k: string, v: string) => chain((r) => new RegExp(`^${v.replace(/[.]/g, "\\.").replace(/%/g, ".*")}$`).test(String(r[k])));
  q.not = () => chain();
  q.or = () => chain();
  q.order = () => chain();
  const answer = async () => (failing.has(table) ? { data: null, error: { message: `${table} read failed` } } : { data: rows(), error: null });
  q.range = answer;
  q.limit = answer;
  q.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null });
  return q;
}
const fleetRpc = vi.fn();
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantRpc: (...a: unknown[]) => rpc(...a),
  tenantClient: () => ({ from: (t: string) => query(t) }),
  fleetSweepClient: () => ({ from: (t: string) => query(t), rpc: (...a: unknown[]) => fleetRpc(...a) }),
}));

const record = vi.fn();
const approve = vi.fn();
vi.mock("@/services/channels/exec-actions", () => ({ recordChannelExecAction: (...a: unknown[]) => record(...a), approveChannelAction: (...a: unknown[]) => approve(...a) }));
vi.mock("../cgo-ad-orders", () => ({ ensureCgoOrderRun: async () => "run1", orderCard: async () => ({ title: "Pause", card: {} }) }));
vi.mock("../cgo-auto-run", () => ({ tenantOwnerId: async () => "owner1" }));
vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn(async () => undefined) } }));

import {
  submitTestStopPause,
  assessTestStop,
  holdFactor,
  monitorTestStops,
  afterTestStopPause,
  pauseIsInFlight,
  testStopCardLine,
  testStopChange,
  testStopHoldReason,
  testStopLine,
  testStopPauseAuthority,
  testStopSpec,
  testStopPauseBody,
  tenantsWithTestStops,
  armCreatedTestStop,
  TEST_STOP_RAISE,
  TEST_STOP_STOPPED,
  type TestStop,
  type TestStopDeps,
} from "../test-stops";

const now = new Date("2026-10-23T12:00:00Z");
const stop = (over: Partial<TestStop> = {}): TestStop => ({
  id: "s1",
  decision_id: "d1",
  name: "Test",
  platform: "google",
  account_id: "123",
  object_id: "c1",
  level: "campaign",
  billing_scope: "object",
  budget_usd: 480,
  envelope: { kind: "gross_since_start", daily_usd: 48, days: 10, amount_usd: 480, started_at: "2026-10-20T12:00:00Z", ends_on: "2026-10-30" },
  baseline: { date: "2026-10-19", amounts: {} },
  started_at: "2026-10-20T12:00:00Z",
  ends_at: "2026-10-30T00:00:00Z",
  ends_on: "2026-10-30",
  source_action_id: "a1",
  parent_object_id: null,
  failing_since: null,
  spent_usd: 0,
  spend_highwater: {},
  exposure_usd: 0,
  state: "monitoring",
  reason: null,
  stop_requested_at: null,
  pause_action_id: null,
  checked_at: null,
  stopped_at: null,
  ...over,
});
const campaign = (over: Record<string, unknown> = {}) => ({
  tenant_id: "t",
  platform: "google",
  account_id: "123",
  object_id: "c1",
  level: "campaign",
  campaign_id: "c1",
  name: "Test campaign",
  budget_kind: "daily",
  budget_usd: 48,
  status: "ENABLED",
  currency: "USD",
  as_of: new Date(now.getTime() - 30 * 60_000).toISOString(),
  source: "api",
  ...over,
});

beforeEach(() => {
  tables = {};
  failing = new Set();
  rpc.mockReset().mockResolvedValue({ data: { status: "armed", id: "s1" }, error: null });
});

describe("the stop's envelope and words", () => {
  it("prices a new object from its daily and the days to the test's end, and never says capped", () => {
    const spec = testStopSpec({ testEnd: { decision_id: "d1", ends_on: "2026-11-03" }, platform: "google", level: "campaign", account_id: "123", object_id: "c1", billing_scope: "object", daily_usd: 48, now });
    expect(spec?.envelope).toMatchObject({ kind: "gross_since_start", daily_usd: 48, days: 11, amount_usd: 528 });
    const line = testStopLine(spec!.envelope);
    expect(line).toBe("Runs $48/day until Nov 3, planned about $528. Zavi pauses it if spend gets there.");
    expect(line).not.toMatch(/cap/i);
  });
  it("takes a ChatGPT lifetime total as the envelope, and nothing when no amount can be priced", () => {
    const base = { testEnd: { decision_id: "d1", ends_on: "2026-11-03" }, platform: "chatgpt" as const, level: "campaign" as const, account_id: "a", object_id: "c", billing_scope: "object" as const, now };
    expect(testStopSpec({ ...base, lifetime_usd: 58, daily_usd: 0 })?.envelope).toMatchObject({ kind: "lifetime_total", amount_usd: 58 });
    expect(testStopSpec({ ...base, daily_usd: 0 })).toBeNull();
    expect(testStopSpec({ ...base, daily_usd: 10, testEnd: { decision_id: "d1", ends_on: "2026-10-23" } })).toBeNull();
  });
  it("adds what happened to the done card's line", () => {
    const e = stop().envelope;
    expect(testStopCardLine(e, "stopped")).toMatch(/Zavi paused it\.$/);
    expect(testStopCardLine(e, "founder_resumed")).toMatch(/You switched it back on/);
    expect(testStopCardLine({ kind: "gross_since_start" }, "monitoring")).toBeNull();
  });
  it("uses each platform's own over-delivery factor", () => {
    expect(holdFactor("meta")).toBe(1.75);
    expect(holdFactor("google")).toBe(2);
    expect(holdFactor("tiktok")).toBe(1);
  });
});

describe("arming at create", () => {
  it("arms with the server envelope and returns the founder's line", async () => {
    const r = await armCreatedTestStop("t", "a1", { decision_id: "d1", ends_on: "2026-11-03" }, { platform: "meta", level: "campaign", account_id: async () => "act_1", object_id: "c9", billing_scope: "campaign_budget", daily_usd: 20 }, now);
    expect(r).toMatchObject({ ok: true });
    expect(rpc).toHaveBeenCalledWith("t", "arm_growth_test_stop", expect.objectContaining({ p_action_id: "a1", p_spec: expect.objectContaining({ account_id: "act_1", object_id: "c9", billing_scope: "campaign_budget", envelope: expect.objectContaining({ amount_usd: 220 }) }) }));
  });
  it("says do not switch on when the row is refused, and needs nothing without a test", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "this object already has an open control" } });
    expect(await armCreatedTestStop("t", "a1", { decision_id: "d1", ends_on: "2026-11-03" }, { platform: "google", level: "campaign", account_id: "1", object_id: "c", billing_scope: "object", daily_usd: 5 }, now)).toMatchObject({ ok: false });
    expect(await armCreatedTestStop("t", "a1", null, { platform: "google", level: "campaign", account_id: "1", object_id: "c", billing_scope: "object", daily_usd: 5 }, now)).toEqual({ ok: true, line: null });
  });
});

describe("when the hourly pass pauses", () => {
  it("waits for the first platform read of a new object, then treats unknown spend as a stop", () => {
    const young = stop({ started_at: new Date(now.getTime() - 60 * 60_000).toISOString() });
    expect(assessTestStop(young, null, null, 24, now)).toMatchObject({ stop: false, wait: true });
    expect(assessTestStop(stop(), null, null, 24, now)).toMatchObject({ stop: true });
  });
  it("stops at the end date, and before the envelope when reporting delay could carry it past", () => {
    const t = { daily_usd: 48, budget_kind: "daily", as_of: campaign().as_of, status: "ENABLED" };
    expect(assessTestStop(stop({ ends_at: now.toISOString() }), t, 10, 24, now).reason).toMatch(/end date/);
    expect(assessTestStop(stop(), t, 300, 24, now).stop).toBe(false);
    expect(assessTestStop(stop(), t, 400, 24, now)).toMatchObject({ stop: true, reason: expect.stringMatching(/reporting delay/) });
    expect(assessTestStop(stop({ platform: "meta" }), t, 390, 24, now).stop).toBe(false);
  });
  it("never stops a lifetime total inside the envelope on exposure alone", () => {
    const t = { daily_usd: 58, budget_kind: "lifetime", as_of: campaign().as_of, status: "ACTIVE" };
    expect(assessTestStop(stop({ platform: "chatgpt", budget_usd: 58 }), t, 50, 24, now).stop).toBe(false);
  });
});

const deps = (over: Partial<TestStopDeps> = {}): TestStopDeps => ({
  reportingDelayHours: async () => 24,
  submitPause: vi.fn(async () => ({ ok: true as const, action_id: "p1" })),
  approvePause: vi.fn(async () => true),
  tellFounder: vi.fn(async () => undefined),
  log: vi.fn(),
  ...over,
});
const savedChecks = () => rpc.mock.calls.filter((c) => c[1] === "record_growth_experiment_check").map((c) => (c[2] as { p_check: Record<string, unknown> }).p_check);

describe("the hourly pass", () => {
  it("files the pause when the stop is due and records it as stopping, never stopped", async () => {
    tables.growth_experiment_controls = [{ tenant_id: "t", kind: "test_stop", ...stop({ ends_at: now.toISOString() }) }];
    tables.ad_campaigns = [campaign()];
    tables.ad_spend_daily = [{ tenant_id: "t", platform: "google", account_id: "123", source: "api", object_id: "c1", spend_date: "2026-10-21", amount_usd: 40 }];
    const d = deps();
    await monitorTestStops("t", now, d);
    expect(d.submitPause).toHaveBeenCalledOnce();
    expect(savedChecks().at(-1)).toMatchObject({ state: "stopping", pause_action_id: "p1", spent_usd: 40, stop: true });
  });
  it("confirms stopped only on a paused read newer than every status change", async () => {
    tables.growth_experiment_controls = [{ tenant_id: "t", kind: "test_stop", ...stop({ ends_at: now.toISOString(), state: "stopping", stop_requested_at: now.toISOString(), pause_action_id: "p1" }) }];
    tables.ad_campaigns = [campaign({ status: "PAUSED" })];
    tables.channel_actions = [{ tenant_id: "t", id: "p1", channel_slug: "google_ads", exec_class: "google_ads.set_status", status: "acted", exec_status: "executed", executed_at: new Date(now.getTime() - 50 * 60_000).toISOString(), exec_claimed_at: null, proposed_at: "2026-10-22T00:00:00Z", exec_payload: { campaign_id: "c1", status: "PAUSED" } }];
    const d = deps();
    await monitorTestStops("t", now, d);
    expect(d.submitPause).not.toHaveBeenCalled();
    expect(savedChecks().at(-1)).toMatchObject({ state: "stopped" });
  });
  it("re-approves a linked pause whose approval never landed instead of waiting forever", async () => {
    tables.growth_experiment_controls = [{ tenant_id: "t", kind: "test_stop", ...stop({ ends_at: now.toISOString(), state: "stopping", stop_requested_at: now.toISOString(), pause_action_id: "p1" }) }];
    tables.ad_campaigns = [campaign()];
    tables.channel_actions = [{ tenant_id: "t", id: "p1", channel_slug: "google_ads", exec_class: "google_ads.set_status", status: "pending", exec_status: null, executed_at: null, exec_claimed_at: null, proposed_at: "2026-10-23T11:30:00Z", exec_payload: { campaign_id: "c1", status: "PAUSED" } }];
    const d = deps();
    await monitorTestStops("t", now, d);
    expect(d.approvePause).toHaveBeenCalledWith("t", "p1");
    expect(d.submitPause).not.toHaveBeenCalled();
  });
  it("closes on the hourly read's removed tombstone, and not on a missing row", async () => {
    tables.growth_experiment_controls = [{ tenant_id: "t", kind: "test_stop", ...stop() }];
    tables.ad_campaigns = [campaign({ status: "REMOVED" })];
    await monitorTestStops("t", now, deps());
    expect(savedChecks().at(-1)).toMatchObject({ state: "object_gone" });
    rpc.mockClear();
    tables.ad_campaigns = [];
    tables.growth_experiment_controls = [{ tenant_id: "t", kind: "test_stop", ...stop({ started_at: new Date(now.getTime() - 3_600_000).toISOString() }) }];
    await monitorTestStops("t", now, deps());
    expect(savedChecks().at(-1)).toMatchObject({ state: "monitoring" });
  });
  it("leaves a stop the founder took back alone", async () => {
    tables.growth_experiment_controls = [{ tenant_id: "t", kind: "test_stop", ...stop({ state: "founder_resumed", stopped_at: now.toISOString() }) }];
    const d = deps();
    await monitorTestStops("t", now, d);
    expect(rpc).not.toHaveBeenCalled();
    expect(d.submitPause).not.toHaveBeenCalled();
  });
  it("a Meta campaign budget with no ad set read yet is unknown spend, not zero", async () => {
    tables.growth_experiment_controls = [{ tenant_id: "t", kind: "test_stop", ...stop({ platform: "meta", account_id: "act_1", billing_scope: "campaign_budget" }) }];
    tables.ad_campaigns = [campaign({ platform: "meta", account_id: "act_1", status: "ACTIVE" })];
    const d = deps();
    await monitorTestStops("t", now, d);
    expect(d.submitPause).toHaveBeenCalledOnce();
  });
});

describe("the pause card's authority", () => {
  it("only the pause linked to an open stop on its own object runs as a stop", async () => {
    tables.growth_experiment_controls = [{ tenant_id: "t", kind: "test_stop", id: "s1", platform: "google", object_id: "c1", state: "stopping", stopped_at: null, pause_action_id: "p1" }];
    expect(await testStopPauseAuthority("t", "p1", "google_ads.set_status", { campaign_id: "c1", status: "PAUSED" })).toBe("stop");
    expect(await testStopPauseAuthority("t", "p1", "google_ads.set_status", { campaign_id: "other", status: "PAUSED" })).toBeNull();
    expect(await testStopPauseAuthority("t", "p1", "google_ads.set_status", { campaign_id: "c1", status: "ENABLED" })).toBeNull();
    expect(await testStopPauseAuthority("t", "p2", "google_ads.set_status", { campaign_id: "c1", status: "PAUSED" })).toBeNull();
    tables.growth_experiment_controls[0]!.state = "founder_resumed";
    expect(await testStopPauseAuthority("t", "p1", "google_ads.set_status", { campaign_id: "c1", status: "PAUSED" })).toBe("resumed");
  });
});

describe("the unattended gate on test objects", () => {
  it("reads switch-ons and raises, not pauses or cuts", () => {
    expect(testStopChange("google_ads.set_status", { campaign_id: "c1", status: "ENABLED" })).toMatchObject({ platform: "google", ids: ["c1"], change: "on" });
    expect(testStopChange("google_ads.set_status", { campaign_id: "c1", status: "PAUSED" })).toBeNull();
    expect(testStopChange("meta_ads.update_ad_set_budget", { ad_set_id: "s1", expected_current_daily_budget_usd: 10, daily_budget_usd: 12 })).toMatchObject({ change: "raise", ids: ["s1"] });
    expect(testStopChange("tiktok_ads.update_budget", { object_id: "g1", campaign_id: "c1", expected_current_daily_budget_usd: 30, daily_budget_usd: 25 })).toBeNull();
  });
  it("a stop Zavi made, or one due, is the founder's; an open stop allows a switch-on but not a raise", () => {
    const open = { state: "monitoring" as const, stopped_at: null, stop_requested_at: null };
    expect(testStopHoldReason([{ ...open, state: "stopped", stopped_at: now.toISOString() }], "on")).toBe(TEST_STOP_STOPPED);
    expect(testStopHoldReason([{ ...open, state: "stopping", stop_requested_at: now.toISOString() }], "on")).toBe(TEST_STOP_STOPPED);
    expect(testStopHoldReason([open], "raise")).toBe(TEST_STOP_RAISE);
    expect(testStopHoldReason([open], "on")).toBeNull();
    expect(testStopHoldReason([{ ...open, state: "founder_resumed", stopped_at: now.toISOString() }], "raise")).toBeNull();
  });
});

describe("finding the tenants to check", () => {
  it("pages distinct tenants by key, with no fleet-wide cap, and includes stops closed this week", async () => {
    const first = Array.from({ length: 1000 }, (_, i) => `t${String(i).padStart(4, "0")}`);
    fleetRpc.mockReset().mockResolvedValueOnce({ data: first, error: null }).mockResolvedValueOnce({ data: ["t9999"], error: null });
    const ids = await tenantsWithTestStops(now);
    expect(ids).toHaveLength(1001);
    expect(fleetRpc.mock.calls[0]).toEqual(["test_stop_tenants", { p_since: "2026-10-16T12:00:00.000Z", p_after: null, p_limit: 1000 }]);
    expect(fleetRpc.mock.calls[1]![1]).toMatchObject({ p_after: "t0999" });
  });
});

describe("the TikTok pause card", () => {
  it("names the ad group's campaign from the stop row when the hourly read has not got it", async () => {
    const body = await testStopPauseBody("t", stop({ platform: "tiktok", level: "ad_group", account_id: "adv", object_id: "g1", parent_object_id: "c7" }), null, "due");
    expect(body).toMatchObject({ level: "ad_group", object_id: "g1", ad_group_id: "g1", campaign_id: "c7", status: "PAUSED", daily_budget_usd: null });
  });
});

describe("a row the hourly pass cannot check", () => {
  it("is paused from its own stop row, the rest still run, and the pass reports the failure so the worker alerts", async () => {
    tables.growth_experiment_controls = [
      { tenant_id: "t", kind: "test_stop", ...stop({ id: "bad" }) },
      { tenant_id: "t", kind: "test_stop", ...stop({ id: "good", object_id: "c2", ends_at: now.toISOString() }) },
    ];
    failing.add("ad_campaigns");
    const d = deps();
    await expect(monitorTestStops("t", now, d)).rejects.toThrow(/could not be checked/);
    expect((d.submitPause as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[1] as TestStop).id)).toEqual(["bad", "good"]);
    expect(d.tellFounder).not.toHaveBeenCalled();
  });
  it("asks the founder when even that pause cannot be filed", async () => {
    tables.growth_experiment_controls = [{ tenant_id: "t", kind: "test_stop", ...stop() }];
    failing.add("ad_campaigns");
    const d = deps({ submitPause: vi.fn(async () => ({ ok: false as const, why: "platform down" })) });
    await expect(monitorTestStops("t", now, d)).rejects.toThrow();
    expect(d.tellFounder).toHaveBeenCalledWith("t", expect.objectContaining({ id: "s1", failing_since: now.toISOString() }), expect.any(String));
    expect(savedChecks().at(-1)).toMatchObject({ state: "needs_attention", failing_since: now.toISOString() });
    tables.growth_experiment_controls[0]!.failing_since = "2026-10-23T09:00:00.000Z";
    await expect(monitorTestStops("t", now, d)).rejects.toThrow();
    expect((d.tellFounder as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1]).toMatchObject({ failing_since: "2026-10-23T09:00:00.000Z" });
  });
  it("a row whose pause is already in flight files no second pause and asks no one; one row counts once", async () => {
    tables.growth_experiment_controls = [{ tenant_id: "t", kind: "test_stop", ...stop({ state: "stopping", stop_requested_at: now.toISOString(), pause_action_id: "p1" }) }];
    tables.channel_actions = [{ tenant_id: "t", id: "p1", status: "approved", exec_status: "dispatching", executed_at: null, exec_claimed_at: "2026-10-23T11:50:00Z", proposed_at: "2026-10-23T11:45:00Z", approved_by_source: "cgo" }];
    failing.add("ad_campaigns");
    const d = deps();
    await expect(monitorTestStops("t", now, d)).rejects.toThrow(/1 of 1 could not be checked/);
    expect(d.submitPause).not.toHaveBeenCalled();
    expect(d.tellFounder).not.toHaveBeenCalled();
  });
  it("a young row that cannot be checked waits for the grace, is not paused, and still alerts", async () => {
    tables.growth_experiment_controls = [{ tenant_id: "t", kind: "test_stop", ...stop({ started_at: new Date(now.getTime() - 3_600_000).toISOString() }) }];
    failing.add("ad_campaigns");
    const d = deps();
    await expect(monitorTestStops("t", now, d)).rejects.toThrow();
    expect(d.submitPause).not.toHaveBeenCalled();
    expect(d.tellFounder).toHaveBeenCalled();
  });
});

describe("after the pause reached the platform", () => {
  it("a founder who switched it back on meanwhile is told to check it (Zavi does not switch spend back on)", async () => {
    tables.growth_experiment_controls = [{ tenant_id: "t", kind: "test_stop", ...stop({ state: "founder_resumed", stopped_at: now.toISOString(), pause_action_id: "p1" }) }];
    expect(await afterTestStopPause("t", "p1", "google_ads.set_status", { campaign_id: "c1", status: "PAUSED" })).toBe("raced_resume");
    tables.growth_experiment_controls[0]!.state = "stopping";
    expect(await afterTestStopPause("t", "p1", "google_ads.set_status", { campaign_id: "c1", status: "PAUSED" })).toBe("ok");
  });
  it("sees a founder switch-on that reached the platform but has not settled yet", async () => {
    tables.growth_experiment_controls = [{ tenant_id: "t", kind: "test_stop", ...stop({ state: "stopping", stop_requested_at: now.toISOString(), pause_action_id: "p1" }) }];
    const founderOn = { tenant_id: "t", channel_slug: "google_ads", exec_class: "google_ads.set_status_review", approved_by: "u1", approved_by_source: null, exec_status: "dispatching", executed_at: null, exec_payload: { campaign_id: "c1", status: "ENABLED" } };
    tables.channel_actions = [founderOn];
    expect(await afterTestStopPause("t", "p1", "google_ads.set_status", { campaign_id: "c1", status: "PAUSED" }, now.toISOString())).toBe("raced_resume");
    tables.channel_actions = [{ ...founderOn, approved_by_source: "cgo" }, { ...founderOn, approved_by_source: "staff" }];
    expect(await afterTestStopPause("t", "p1", "google_ads.set_status", { campaign_id: "c1", status: "PAUSED" }, now.toISOString())).toBe("ok");
    tables.channel_actions = [];
    tables.decisions = [{ tenant_id: "t", decision_class: "google_ads.set_status", status: "dispatching", approved_by: "u1", approved_by_source: null, body: { campaign_id: "c1", status: "ENABLED" } }];
    expect(await afterTestStopPause("t", "p1", "google_ads.set_status", { campaign_id: "c1", status: "PAUSED" }, now.toISOString())).toBe("raced_resume");
  });
});

describe("a linked pause that will never land", () => {
  const pause = (over: Record<string, unknown>) => ({ tenant_id: "t", id: "p1", channel_slug: "google_ads", exec_class: "google_ads.set_status", status: "approved", exec_status: "dispatching", executed_at: null, exec_claimed_at: "2026-10-23T11:50:00Z", proposed_at: "2026-10-23T11:45:00Z", approved_by_source: "cgo", exec_payload: { campaign_id: "c1", status: "PAUSED" }, ...over });
  it("is in flight only while waiting, queued or dispatching, and only for a bounded time", () => {
    expect(pauseIsInFlight(pause({}), now)).toBe(true);
    expect(pauseIsInFlight(pause({ status: "pending", exec_status: null, exec_claimed_at: null }), now)).toBe(true);
    expect(pauseIsInFlight(pause({ exec_status: "failed" }), now)).toBe(false);
    expect(pauseIsInFlight(pause({ status: "rejected", exec_status: null, exec_claimed_at: null }), now)).toBe(false);
    expect(pauseIsInFlight(pause({ status: "stale", exec_status: null, exec_claimed_at: null }), now)).toBe(false);
    expect(pauseIsInFlight(pause({ exec_claimed_at: "2026-10-23T09:00:00Z" }), now)).toBe(false);
    expect(pauseIsInFlight(null, now)).toBe(false);
  });
  for (const [label, over] of [
    ["rejected", { status: "rejected", exec_status: null, exec_claimed_at: null }],
    ["failed", { exec_status: "failed" }],
    ["stuck dispatching for 3 hours", { exec_claimed_at: "2026-10-23T09:00:00Z", proposed_at: "2026-10-23T08:55:00Z" }],
  ] as const) {
    it(`a ${label} pause is filed again`, async () => {
      tables.growth_experiment_controls = [{ tenant_id: "t", kind: "test_stop", ...stop({ ends_at: now.toISOString(), state: "stopping", stop_requested_at: "2026-10-23T08:50:00Z", pause_action_id: "p1" }) }];
      tables.ad_campaigns = [campaign()];
      tables.channel_actions = [pause(over)];
      const d = deps();
      await monitorTestStops("t", now, d);
      expect(d.submitPause).toHaveBeenCalledOnce();
      expect(savedChecks().at(-1)).toMatchObject({ state: "stopping", pause_action_id: "p1" });
    });
  }
  it("a stuck pause that cannot be replaced tells the founder and fails the pass (the worker alerts)", async () => {
    tables.growth_experiment_controls = [{ tenant_id: "t", kind: "test_stop", ...stop({ ends_at: now.toISOString(), state: "stopping", stop_requested_at: "2026-10-23T08:50:00Z", pause_action_id: "p1" }) }];
    tables.ad_campaigns = [campaign()];
    tables.channel_actions = [pause({ exec_claimed_at: "2026-10-23T09:00:00Z" })];
    const d = deps({ submitPause: vi.fn(async () => ({ ok: false as const, why: "an earlier card on this ad (p1) is still open or stuck" })) });
    await expect(monitorTestStops("t", now, d)).rejects.toThrow(/could not be checked/);
    expect(d.tellFounder).toHaveBeenCalledOnce();
    expect(savedChecks().at(-1)).toMatchObject({ state: "stop_failed" });
  });
  it("when the check itself fails, a failed linked pause is filed again from the row, and the founder is told if that fails too", async () => {
    tables.growth_experiment_controls = [{ tenant_id: "t", kind: "test_stop", ...stop({ state: "stopping", stop_requested_at: "2026-10-23T08:50:00Z", pause_action_id: "p1" }) }];
    tables.channel_actions = [pause({ exec_status: "failed" })];
    failing.add("ad_campaigns");
    const d = deps({ submitPause: vi.fn(async () => ({ ok: false as const, why: "platform down" })) });
    await expect(monitorTestStops("t", now, d)).rejects.toThrow();
    expect(d.submitPause).toHaveBeenCalledOnce();
    expect(d.tellFounder).toHaveBeenCalledOnce();
  });
});

describe("filing the pause card", () => {
  beforeEach(() => {
    record.mockReset();
    approve.mockReset().mockResolvedValue({ ok: true, attempt: 1, alreadyQueued: false, replayed: false });
    rpc.mockReset().mockResolvedValue({ data: "applied", error: null });
  });
  it("links a new card before approving it", async () => {
    record.mockResolvedValue({ id: "p2", replayed: false });
    const r = await submitTestStopPause("t", stop({ pause_action_id: "p1" }), campaign() as never, "due", now);
    expect(r).toEqual({ ok: true, action_id: "p2" });
    expect(rpc.mock.calls[0]![2]).toMatchObject({ p_check: expect.objectContaining({ pause_action_id: "p2" }) });
    expect(approve).toHaveBeenCalledOnce();
  });
  it("never re-links the stuck pause the writer hands back, nor a card it kept", async () => {
    record.mockResolvedValue({ id: "p1", replayed: true });
    expect(await submitTestStopPause("t", stop({ pause_action_id: "p1" }), campaign() as never, "due", now)).toMatchObject({ ok: false });
    record.mockResolvedValue({ id: "f9", replayed: false, kept: true });
    expect(await submitTestStopPause("t", stop({ pause_action_id: "p1" }), campaign() as never, "due", now)).toMatchObject({ ok: false });
    expect(rpc).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
  });
  it("is not approved when its link did not land", async () => {
    record.mockResolvedValue({ id: "p2", replayed: false });
    rpc.mockResolvedValue({ data: "conflict", error: null });
    expect(await submitTestStopPause("t", stop(), campaign() as never, "due", now)).toMatchObject({ ok: false });
    expect(approve).not.toHaveBeenCalled();
  });
});
