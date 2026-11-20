import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  runs: [] as Row[],
  decisions: [] as Row[],
  reservations: [] as Row[],
  fail: null as string | null,
}));
const live = vi.hoisted(() => ({ google: null as string | null, metaSet: null as string | null, metaSets: [] as Array<{ end_time?: string }>, next: false }));

function query(table: string) {
  const filters: Array<[string, unknown]> = [];
  const rows = () => {
    if (db.fail === table) return { data: null, error: { message: `${table} down` } };
    const all = table === "agent_runs" ? db.runs : table === "decisions" ? db.decisions : db.reservations;
    return { data: all.filter((r) => filters.every(([k, v]) => r[k] === v)), error: null };
  };
  const q = {
    select: () => q,
    eq: (k: string, v: unknown) => {
      filters.push([k, v]);
      return q;
    },
    limit: async () => rows(),
    maybeSingle: async () => {
      const r = rows();
      return r.error ? r : { data: r.data![0] ?? null, error: null };
    },
  };
  return q;
}
vi.mock("@/services/tenant-client", async (orig) => ({
  ...(await orig<typeof import("@/services/tenant-client")>()),
  asTenantId: (t: string) => t,
  tenantClient: () => ({ from: (t: string) => query(t) }),
}));
vi.mock("@/services/tools/google-ads/_client", () => ({
  gadsGetCampaignEnd: async () => ({ end_date_time: live.google }),
}));
vi.mock("@/services/tools/meta-ads/_client", () => ({
  fbGet: async (_t: string, path: string) => (path.endsWith("/adsets") ? { data: live.metaSets, ...(live.next ? { paging: { next: "x" } } : {}) } : { id: path, campaign_id: "1110001", end_time: live.metaSet ?? undefined }),
}));
vi.mock("../ads-no-friction-flag", () => ({ adsNoFrictionEnabled: async () => true }));

import {
  cgoTestEndForRun,
  dayBefore,
  earlierEndDay,
  earlierEndIso,
  endWithinTest,
  googleEndWithinTest,
  metaTestEndTime,
  testCreateEndSupport,
} from "../cgo-test-end";
import { evaluateUnattended, heldReasonWords, loadTestEndFact, type UnattendedAction } from "../unattended-policy";

const T = "11111111-1111-4111-8111-111111111111";
const ORDER = "1ffe4e30-87cc-43b7-aa32-9252072beb36";
const order = (over: Row = {}): Row => ({
  id: ORDER,
  tenant_id: T,
  emitted_at: "2026-10-20T10:00:00Z",
  decision_class: "cgo.dispatch-specialist",
  body: { dispatched_by: "cgo", target_agent_slug: "google_ads", test: { variable: "a new campaign", baseline: "0", success_if: "5 leads", readout_on: "2026-11-03" } },
  ...over,
});

beforeEach(() => {
  db.runs = [{ id: "run-1", tenant_id: T, source_decision_id: ORDER, payload_source: null }];
  db.decisions = [order()];
  db.reservations = [];
  db.fail = null;
  live.google = null;
  live.metaSet = null;
  live.metaSets = [];
  live.next = false;
});

describe("the test's end for a run", () => {
  it("a cgo order's run: its readout day, or one window later for a late launch", async () => {
    expect(await cgoTestEndForRun(T, "run-1", new Date("2026-10-20T15:00:00Z"))).toEqual({ decision_id: ORDER, channel: "google_ads", ends_on: "2026-11-03" });
    expect((await cgoTestEndForRun(T, "run-1", new Date("2026-10-25T09:00:00Z")))?.ends_on).toBe("2026-11-08");
  });

  it("the order id from the run's payload works too", async () => {
    db.runs = [{ id: "run-1", tenant_id: T, source_decision_id: null, payload_source: ORDER }];
    expect((await cgoTestEndForRun(T, "run-1"))?.decision_id).toBe(ORDER);
  });

  it("not a test: no run, no order, not a cgo order, no test", async () => {
    expect(await cgoTestEndForRun(T, null)).toBeNull();
    expect(await cgoTestEndForRun(T, "other-run")).toBeNull();
    db.decisions = [order({ decision_class: "meta_ads.create_ad_set" })];
    expect(await cgoTestEndForRun(T, "run-1")).toBeNull();
    db.decisions = [order({ body: { dispatched_by: "growth-lead", test: (order().body as Row).test } })];
    expect(await cgoTestEndForRun(T, "run-1")).toBeNull();
    db.decisions = [order({ body: { dispatched_by: "cgo", test_exempt: "a diagnosis" } })];
    expect(await cgoTestEndForRun(T, "run-1")).toBeNull();
  });

  it("another tenant's run or order is never read as this tenant's", async () => {
    db.runs = [{ id: "run-1", tenant_id: "22222222-2222-4222-8222-222222222222", source_decision_id: ORDER }];
    expect(await cgoTestEndForRun(T, "run-1")).toBeNull();
  });

  it("a read error or an unreadable test throws (callers fail closed)", async () => {
    db.fail = "agent_runs";
    await expect(cgoTestEndForRun(T, "run-1")).rejects.toThrow(/run read failed/);
    db.fail = "decisions";
    await expect(cgoTestEndForRun(T, "run-1")).rejects.toThrow(/order read failed/);
    db.fail = null;
    db.decisions = [order({ body: { dispatched_by: "cgo", test: { variable: "" } } })];
    await expect(cgoTestEndForRun(T, "run-1")).rejects.toThrow(/could not be read/);
  });
});

describe("end arithmetic", () => {
  it("a body's own end wins only when it is sooner", () => {
    expect(earlierEndDay("2026-10-31", "2026-11-03")).toBe("2026-10-31");
    expect(earlierEndDay("2026-12-31", "2026-11-03")).toBe("2026-11-03");
    expect(earlierEndDay(undefined, "2026-11-03")).toBe("2026-11-03");
    expect(earlierEndDay("next week", "2026-11-03")).toBe("2026-11-03");
    expect(earlierEndIso("2026-11-01T12:00:00Z", "2026-11-03")).toBe("2026-11-01T12:00:00Z");
    expect(earlierEndIso("2026-11-09T00:00:00Z", "2026-11-03")).toBe("2026-11-03T00:00:00Z");
    expect(earlierEndIso(null, "2026-11-03")).toBe("2026-11-03T00:00:00Z");
    expect(metaTestEndTime("2026-11-01T12:00:00+0000", "2026-11-03")).toBe("2026-11-01T12:00:00+0000");
    expect(metaTestEndTime(undefined, "2026-11-03")).toBe("2026-11-03T00:00:00+00:00");
  });

  it("read-backs: Google's last day is the day before its exclusive end; Meta's +0000 parses", () => {
    expect(dayBefore("2026-11-03")).toBe("2026-11-02");
    expect(googleEndWithinTest("2026-11-02 23:59:59", "2026-11-03")).toBe(true);
    expect(googleEndWithinTest("2026-11-03 23:59:59", "2026-11-03")).toBe(false);
    expect(googleEndWithinTest("2037-12-30 23:59:59", "2026-11-03")).toBe(false);
    expect(googleEndWithinTest(null, "2026-11-03")).toBe(false);
    expect(endWithinTest("2026-11-03T00:00:00+0000", "2026-11-03")).toBe(true);
    expect(endWithinTest("2026-11-02T16:00:00-0800", "2026-11-03")).toBe(true);
    expect(endWithinTest("2026-11-03T00:00:01Z", "2026-11-03")).toBe(false);
    expect(endWithinTest(Math.floor(Date.parse("2026-11-02T00:00:00Z") / 1000), "2026-11-03")).toBe(true);
    expect(endWithinTest(undefined, "2026-11-03")).toBe(false);
  });

  it("which creates can carry an end Zavi writes", () => {
    const g = { channel: "google_ads" };
    expect(testCreateEndSupport("google_ads.create_campaign", { channel_type: "SEARCH" }, g, true)).toBe("ok");
    expect(testCreateEndSupport("google_ads.create_campaign", { channel_type: "DEMAND_GEN" }, g, true)).toBe("no_end");
    expect(testCreateEndSupport("google_ads.create_campaign", { channel_type: "SEARCH" }, { channel: "youtube_ads" }, true)).toBe("no_end");
    expect(testCreateEndSupport("meta_ads.duplicate_ad_set", {}, { channel: "meta_ads" }, true)).toBe("ok");
    expect(testCreateEndSupport("meta_ads.create_ad_set", {}, { channel: "meta_ads" }, true)).toBe("no_end");
    expect(testCreateEndSupport("reddit_ads.launch_campaign", {}, { channel: "reddit_ads" }, true)).toBe("no_end");
    expect(testCreateEndSupport("linkedin_ads.launch_campaign", {}, { channel: "linkedin_ads" }, true)).toBe("no_end");
    expect(testCreateEndSupport("tiktok_ads.create_launch", {}, { channel: "tiktok_ads" }, true)).toBe("ok");
    expect(testCreateEndSupport("tiktok_ads.create_launch", {}, { channel: "tiktok_ads" }, false)).toBe("no_end");
    expect(testCreateEndSupport("meta_ads.create_ad", {}, { channel: "meta_ads" }, true)).toBe("ok");
    expect(testCreateEndSupport("google_ads.add_keywords", {}, g, true)).toBe("ok");
  });
});

const ad = (exec_class: string, payload: Row): UnattendedAction => ({ kind: "ad", exec_class, payload, source: { table: "channel_actions", id: "card-1", run_id: "run-1" } }) as UnattendedAction;

describe("the unattended gate: a test ad that cannot stop on its own waits for the founder", () => {
  it("a create with no end support is asked, with plain words; an allow becomes an ask, a deny stays a deny", async () => {
    db.decisions = [order({ body: { ...(order().body as Row), target_agent_slug: "meta_ads" } })];
    const action = ad("meta_ads.create_ad_set", {});
    expect(await loadTestEndFact(T, action as never, new Date("2026-10-21T00:00:00Z"))).toBe("no_end");
    const v = evaluateUnattended(ad("meta_ads.create_custom_audience", {}), { testEnd: "no_end", refsResolved: true, openAdvice: "clear", goal: { present: false }, channelAutorun: true });
    expect(v).toMatchObject({ verdict: "ask_founder", reasons: ["test_end_unsupported"] });
    expect(heldReasonWords(v.reasons)[0]).toMatch(/I cannot give this ad an end date, so I will not start it on my own/);
    const denied = evaluateUnattended(ad("meta_ads.delete_campaign", {}), { testEnd: "no_end" });
    expect(denied.verdict).toBe("deny");
    expect(denied.reasons).toContain("test_end_unsupported");
  });

  it("a create whose end the server writes is not held for it", async () => {
    expect(await loadTestEndFact(T, ad("google_ads.create_campaign", { channel_type: "SEARCH" }) as never, new Date("2026-10-21T00:00:00Z"))).toBeUndefined();
  });

  it("switching on a Google campaign Zavi created: its live end must stop it by the test's end", async () => {
    db.reservations = [{ tenant_id: T, platform: "google", op: "create", status: "committed", object_id: "555" }];
    const enable = ad("google_ads.set_status", { campaign_id: "555", status: "ENABLED", level: "campaign", rationale: "test", over_cap: false });
    live.google = "2026-11-02 23:59:59";
    expect(await loadTestEndFact(T, enable as never, new Date("2026-10-21T00:00:00Z"))).toBeUndefined();
    live.google = null;
    expect(await loadTestEndFact(T, enable as never, new Date("2026-10-21T00:00:00Z"))).toBe("unverified");
    live.google = null;
    db.reservations = [{ tenant_id: T, platform: "google", op: "create", status: "committed", object_id: "555" }];
    expect(await loadTestEndFact(T, ad("google_ads.set_status", { campaign_id: "555", ad_group_id: "777", status: "ENABLED", level: "ad_group", rationale: "test", over_cap: false }) as never, new Date("2026-10-21T00:00:00Z"))).toBe("unverified");
    db.reservations = [];
    expect(await loadTestEndFact(T, enable as never, new Date("2026-10-21T00:00:00Z"))).toBeUndefined();
  });

  it("switching on a Meta campaign Zavi created: every ad set must end by the test's end", async () => {
    db.decisions = [order({ body: { ...(order().body as Row), target_agent_slug: "meta_ads" } })];
    db.reservations = [{ tenant_id: T, platform: "meta", op: "create", status: "committed", object_id: "1110001" }];
    const enable = ad("meta_ads.set_status", { object_id: "1110001", level: "campaign", status: "ACTIVE", rationale: "test", over_cap: false });
    live.metaSets = [{ end_time: "2026-11-03T00:00:00+0000" }, { end_time: "2026-11-01T00:00:00+0000" }];
    expect(await loadTestEndFact(T, enable as never, new Date("2026-10-21T00:00:00Z"))).toBeUndefined();
    live.metaSets = [{ end_time: "2026-11-03T00:00:00+0000" }, {}];
    expect(await loadTestEndFact(T, enable as never, new Date("2026-10-21T00:00:00Z"))).toBe("unverified");
    live.metaSets = [];
    expect(await loadTestEndFact(T, enable as never, new Date("2026-10-21T00:00:00Z"))).toBe("unverified");
  });

  it("an ad set inside a campaign Zavi launched is judged by its own live end; a later end_time edit is never unattended", async () => {
    db.decisions = [order({ body: { ...(order().body as Row), target_agent_slug: "meta_ads" } })];
    db.reservations = [{ tenant_id: T, platform: "meta", op: "create", status: "committed", object_id: "1110001" }];
    const enableSet = ad("meta_ads.set_status", { object_id: "2220001", level: "adset", status: "ACTIVE", rationale: "test", over_cap: false });
    live.metaSet = null;
    expect(await loadTestEndFact(T, enableSet as never, new Date("2026-10-21T00:00:00Z"))).toBe("unverified");
    live.metaSet = "2026-11-02T00:00:00+0000";
    expect(await loadTestEndFact(T, enableSet as never, new Date("2026-10-21T00:00:00Z"))).toBeUndefined();
    const later = ad("meta_ads.update_ad_set", { ad_set_id: "2220001", end_time: "2026-11-20T00:00:00+0000" });
    expect(await loadTestEndFact(T, later as never, new Date("2026-10-21T00:00:00Z"))).toBe("unverified");
    const sooner = ad("meta_ads.update_ad_set", { ad_set_id: "2220001", end_time: "2026-11-01T00:00:00+0000" });
    expect(await loadTestEndFact(T, sooner as never, new Date("2026-10-21T00:00:00Z"))).toBeUndefined();
  });

  it("not a test's run: nothing; the test or a live read cannot be read: the founder decides", async () => {
    db.runs = [];
    expect(await loadTestEndFact(T, ad("meta_ads.create_ad_set", {}) as never, new Date())).toBeUndefined();
    db.runs = [{ id: "run-1", tenant_id: T, source_decision_id: ORDER }];
    db.fail = "decisions";
    expect(await loadTestEndFact(T, ad("meta_ads.create_ad_set", {}) as never, new Date())).toBe("unreadable");
    expect(heldReasonWords(["test_end_unreadable"])[0]).toBe("I could not read this test's end date");
  });
});
