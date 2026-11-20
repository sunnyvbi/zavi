
import { describe, it, expect, vi } from "vitest";

vi.mock("../business-control-runtime", async (orig) => ({
  ...(await orig<typeof import("../business-control-runtime")>()),
  monitorExperiments: async () => undefined,
}));
vi.mock("../experiment-controls", async (orig) => ({
  ...(await orig<typeof import("../experiment-controls")>()),
  readExperiments: async () => [],
}));
vi.mock("../unattended-policy", async (orig) => ({
  ...(await orig<typeof import("../unattended-policy")>()),
  loadPausedByFounder: vi.fn(),
}));

vi.mock("../cgo-ads", async (orig) => ({ ...(await orig<typeof import("../cgo-ads")>()), cgoAdBudget: async () => null }));

import { submitCgoAdAction, type CgoAdOrderResult } from "../cgo-ad-orders";
import { runSpendControllerForTenant, type AdObject, type ControllerDeps, type Inventory } from "../ad-spend-controller";
import type { CgoAdOrderInput } from "../cgo-ad-orders";
import { orderBodyProblem } from "../cgo-order-validate";
import type { SpendPace } from "@/services/growth/spend-pace";
import {
  MAKE_ROOM_FREES_KEY,
  MAKE_ROOM_REVISION_KEY,
  MAKE_ROOM_TEST_KEY,
  freedDailyUsd,
  holdKeyOf,
  planMakeRoomCuts,
  shortTests,
  sizeCut,
  type MakeRoomNeed,
  type ObjectHold,
} from "../pending-test-room-cuts";
import { evaluateUnattended, type AdObjectFacts, type UnattendedFacts } from "../unattended-policy";
import { runPendingTestsForTenant, renewUntil, claimIdemKey, type ClaimDeps } from "../pending-test-claim";
import type { PendingTestRow } from "../pending-tests";
import type { ActiveAdBudget, AdSpendHold } from "@/services/decisions/ad-budget";

const T = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-10-12T12:00:00Z");
const DAY = 86_400_000;
const TEST_ID = "9b0c2d4e-1f3a-4b5c-8d7e-6f5a4b3c2d1e";

function ad(id: string, cprUsd: number, over: Partial<AdObject> = {}): AdObject {
  const results = Math.round(700 / cprUsd);
  return {
    platform: "meta",
    level: "ad_set",
    id,
    campaign_id: "c1",
    name: id,
    active: true,
    paused_self: false,
    parent_active: true,
    daily_budget_usd: 100,
    budget_on_campaign: false,
    spend7d_usd: 700,
    spend3d_usd: 300,
    spend_days7d: 7,
    results7d: results,
    result_kind: "conversions",
    settled: { spend_usd: 700, results, purchases: 0, purchase_value_usd: 0 },
    has_live_ads: true,
    has_any_ads: true,
    has_ready_ads: true,
    audience_ids: [],
    created_at: "2026-09-01T00:00:00Z",
    ...over,
  };
}
const gcamp = (id: string, cprUsd: number, over: Partial<AdObject> = {}) => ad(id, cprUsd, { platform: "google", level: "campaign", campaign_id: id, ...over });
const inv = (meta: AdObject[], google: AdObject[] = []): Inventory => ({ meta: { connected: meta.length > 0, objects: meta, ads: [] }, google: { connected: google.length > 0, objects: google, conversions30d: google.length ? 50 : null } });
const pacedAt = (liveUsd: number): SpendPace => ({ daily_target_usd: liveUsd / 1.2, required_cumulative_usd: 1000, actual_month_usd: 900, delivery_debt_usd: 0, days_left: 20, data_fresh: true }) as SpendPace;

const need = (left_usd: number, over: Partial<MakeRoomNeed> = {}): MakeRoomNeed => ({
  budget_id: "b1",
  left_usd,
  days_left: 20,
  margin: 1,
  tests: [{ id: TEST_ID, revision: 3, channel: "tiktok_ads", daily_budget_usd: 25, hold_usd: 500, created_at: "2026-10-10T00:00:00Z" }],
  inflight_usd: 0,
  inflight: 0,
  ...over,
});
const zaviMade = (daily: number): ObjectHold => ({ held_daily_usd: daily, base_usd: 0 });

function fake(objects: { meta?: AdObject[]; google?: AdObject[] }, opts: { live: number; room?: MakeRoomNeed | null; holds?: Record<string, ObjectHold>; extra?: Partial<ControllerDeps> }) {
  const submitted: CgoAdOrderInput[] = [];
  const logs: Array<{ code: string; message: string }> = [];
  const gateCalls: string[] = [];
  const deps = {
    cgoAdBudget: async () => ({ id: "b1" }),
    loadSpendPace: async () => pacedAt(opts.live),
    readMeta: async () => inv(objects.meta ?? []).meta,
    readGoogle: async () => inv([], objects.google ?? []).google,
    ledgerCapacity: async () => null,
    metaThrottled: async () => null,
    noteMetaRateLimit: async () => undefined,
    recentOrderKeys: async () => new Set<string>(),
    enableSafe: async () => new Set<string>(),
    cutLocked: async () => false,
    askFounder: async () => true,
    submit: async (i: CgoAdOrderInput) => {
      submitted.push(i);
      return { ok: true as const, action_id: `a${submitted.length}` };
    },
    wakeCgo: async () => ({ woke: true }),
    retarget: () => ({ readWebsiteAudience: async () => null, readAdSetSetup: async () => null, readCreativeCopy: async () => null }),
    creative: () => ({ fatiguedAdSets: async () => new Set<string>(), readCreativeCopy: async () => null, generateImage: async () => null }),
    maintainHolds: async () => ({}),
    makeRoomNeed: async () => (opts.room === undefined ? null : opts.room),
    objectHolds: async () => new Map(Object.entries(opts.holds ?? {})),
    makeRoomGate: async (_t: string, o: { dwell_key: string }) => {
      gateCalls.push(o.dwell_key);
      return { ok: true, reasons: [] };
    },
    log: (_t: string, code: string, message: string) => logs.push({ code, message }),
    ...opts.extra,
  } as unknown as ControllerDeps;
  return { deps, submitted, logs, gateCalls };
}
const cutOf = (s: CgoAdOrderInput[], id: string) => s.find((o) => (o.body.ad_set_id === id || o.body.campaign_id === id) && /budget/.test(o.exec_class));

const homeServices = (over: Partial<AdObject> = {}) => [
  ad("deep-clean", 18),
  ad("move-out", 20),
  ad("weekly", 22),
  ad("windows", 50, { daily_budget_usd: 400, spend7d_usd: 1400, results7d: 28, settled: { spend_usd: 1400, results: 28, purchases: 0, purchase_value_usd: 0 }, ...over }),
];

describe("make room: a fully paced cap and a waiting TikTok test", () => {
  it("must catch (Meta-heavy marketplace): a clearly worse Zavi-held ad set is cut by just the test's room, the sync frees left_usd and the claim files the card", async () => {
    const dynamicNeed = need(100);
    dynamicNeed.tests[0].hold_usd = 625;
    const f = fake({ meta: homeServices() }, { live: 400, room: dynamicNeed, holds: { [holdKeyOf("meta", "windows")]: zaviMade(400) } });
    await runSpendControllerForTenant(T, NOW, f.deps);
    const cut = cutOf(f.submitted, "windows");
    expect(cut?.body).toMatchObject({ daily_budget_usd: 373.75, expected_current_daily_budget_usd: 400, [MAKE_ROOM_TEST_KEY]: TEST_ID, [MAKE_ROOM_REVISION_KEY]: 3, [MAKE_ROOM_FREES_KEY]: 525 });
    expect(cut?.exec_class).toBe("meta_ads.update_ad_set_budget");
    expect(cut?.reason).toMatch(/to make room for the TikTok first test/);
    expect(cut?.dwell_key).toBe("cut:meta:windows");
    expect(await orderBodyProblem(cut!.exec_class, cut!.body)).toBeNull();
    expect(f.submitted.filter((o) => /budget/.test(o.exec_class))).toHaveLength(1);
    expect(f.gateCalls).toEqual(["cut:meta:windows"]);
    expect(f.logs.find((l) => l.code === "cgo.spend_controller_make_room_cut")?.message).toMatch(new RegExp(`${TEST_ID}.*\\$400\\.00 -> \\$373\\.75.*frees about \\$525\\.00`));

    const freedDaily = freedDailyUsd(zaviMade(400), 400, 373.75);
    const leftAfter = 100 + freedDaily * 20;
    expect(leftAfter).toBeGreaterThanOrEqual(625);
    const claim = claimWorld([pending()], leftAfter);
    const out = await runPendingTestsForTenant(T, NOW, {}, claim.deps);
    expect(out).toMatchObject({ claimed: 1, filed: 1 });
  });

  it("must not catch: with no pending test, a fully paced cap cuts nothing (only surplus is cut)", async () => {
    const f = fake({ meta: homeServices() }, { live: 400, room: null, holds: { [holdKeyOf("meta", "windows")]: zaviMade(400) } });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(cutOf(f.submitted, "windows")).toBeUndefined();
    expect(f.gateCalls).toEqual([]);
  });

  it("no pending test and surplus: the normal 20% cut, unchanged", async () => {
    const f = fake({ meta: homeServices() }, { live: 100, room: null });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(cutOf(f.submitted, "windows")?.body.daily_budget_usd).toBe(320);
    expect(cutOf(f.submitted, "windows")?.body[MAKE_ROOM_TEST_KEY]).toBeUndefined();
  });

  it("a test whose hold already fits in left_usd cuts nothing (the claim takes it)", async () => {
    const f = fake({ meta: homeServices() }, { live: 400, room: need(600), holds: { [holdKeyOf("meta", "windows")]: zaviMade(400) } });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(cutOf(f.submitted, "windows")).toBeUndefined();
  });

  it("a big shortfall: at most the normal 20% step per object, then the next clearly worse one, and the rest is logged short", async () => {
    const meta = [...homeServices(), ad("gutters", 60, { daily_budget_usd: 200, spend7d_usd: 1200, settled: { spend_usd: 1200, results: 20, purchases: 0, purchase_value_usd: 0 } })];
    const holds = { [holdKeyOf("meta", "windows")]: zaviMade(400), [holdKeyOf("meta", "gutters")]: zaviMade(200) };
    const f = fake({ meta }, { live: 500, room: need(0, { tests: [{ id: TEST_ID, revision: 1, channel: "tiktok_ads", daily_budget_usd: 250, hold_usd: 5000, created_at: "2026-10-10T00:00:00Z" }] }), holds });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(cutOf(f.submitted, "windows")?.body.daily_budget_usd).toBe(320);
    expect(cutOf(f.submitted, "gutters")?.body.daily_budget_usd).toBe(160);
    const short = f.logs.find((l) => l.code === "cgo.spend_controller_make_room_short");
    expect(short?.message).toMatch(new RegExp(`TikTok test ${TEST_ID} still short \\$2600\\.00`));
  });

  it("must catch: a NEW ad (5 days old, inside its learning lock) is judged like any other on this path, not on the normal path", async () => {
    const young = { created_at: "2026-10-07T00:00:00Z", spend_days7d: 5 };
    const locked = { cutLocked: async (_t: string, o: AdObject) => o.id === "windows" };
    const room = fake({ meta: homeServices(young) }, { live: 400, room: need(100), holds: { [holdKeyOf("meta", "windows")]: zaviMade(400) }, extra: locked });
    await runSpendControllerForTenant(T, NOW, room.deps);
    expect(cutOf(room.submitted, "windows")?.body.daily_budget_usd).toBe(380);
    const normal = fake({ meta: homeServices(young) }, { live: 100, room: null, extra: locked });
    await runSpendControllerForTenant(T, NOW, normal.deps);
    expect(cutOf(normal.submitted, "windows")).toBeUndefined();
  });

  it("must not catch: brand, traffic, retargeting budgets and objects Zavi holds nothing for are never cut for the test", async () => {
    const worse = { daily_budget_usd: 400, spend7d_usd: 1400, results7d: 28, settled: { spend_usd: 1400, results: 28, purchases: 0, purchase_value_usd: 0 } };
    const brand = gcamp("801", 50, { brand: true, ...worse });
    const cbo = ad("cbo", 50, { level: "campaign", campaign_id: "cbo", ...worse });
    const rt = ad("rt", 50, { campaign_id: "cbo", budget_on_campaign: true, ...worse, daily_budget_usd: null, audience_ids: ["visitors"] });
    const traffic = ad("blog", 50, { result_kind: "clicks", ...worse });
    const meta = [...homeServices().slice(0, 3), cbo, rt, traffic, homeServices()[3]!];
    const holds = Object.fromEntries(["cbo", "blog"].map((id) => [holdKeyOf("meta", id), zaviMade(400)]).concat([[holdKeyOf("google", "801"), zaviMade(400)]]));
    const f = fake({ meta, google: [brand, gcamp("802", 20), gcamp("803", 22), gcamp("804", 18)] }, { live: 900, room: need(100), holds });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(f.submitted.filter((o) => /budget|status/.test(o.exec_class))).toEqual([]);
    expect(f.logs.find((l) => l.code === "cgo.spend_controller_make_room_short")?.message).toMatch(/hold no Zavi budget/);
  });

  it("must not catch: a cut the gate would hold (founder-set budget, tracking) is skipped for the next clearly worse one, with no founder question", async () => {
    const meta = [...homeServices(), ad("gutters", 60, { daily_budget_usd: 200, spend7d_usd: 1200, settled: { spend_usd: 1200, results: 20, purchases: 0, purchase_value_usd: 0 } })];
    const holds = { [holdKeyOf("meta", "windows")]: zaviMade(400), [holdKeyOf("meta", "gutters")]: zaviMade(200) };
    const asked: string[] = [];
    const f = fake({ meta }, {
      live: 500,
      room: need(300),
      holds,
      extra: {
        askFounder: async (_t: string, topic: string) => (asked.push(topic), true),
        makeRoomGate: async (_t: string, o: { dwell_key: string }) => (o.dwell_key === "cut:meta:gutters" ? { ok: false, reasons: ["founder_set_budget"] } : { ok: true, reasons: [] }),
      },
    });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(cutOf(f.submitted, "gutters")).toBeUndefined();
    expect(cutOf(f.submitted, "windows")?.body.daily_budget_usd).toBe(390);
    expect(asked).toEqual([]);
  });

  it("all protected: nothing cut, and the reason is logged", async () => {
    const f = fake({ meta: homeServices() }, {
      live: 400,
      room: need(100),
      holds: { [holdKeyOf("meta", "windows")]: zaviMade(400) },
      extra: { makeRoomGate: async () => ({ ok: false, reasons: ["tracking_broken"] }) },
    });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(cutOf(f.submitted, "windows")).toBeUndefined();
    expect(f.logs.find((l) => l.code === "cgo.spend_controller_make_room_short")?.message).toMatch(/held by the gate: cut:meta:windows \(tracking_broken\)/);
  });

  it("a cut already in flight for the test: no second cut for the same dollars", async () => {
    const f = fake({ meta: homeServices() }, { live: 400, room: need(100, { inflight_usd: 400, inflight: 1 }), holds: { [holdKeyOf("meta", "windows")]: zaviMade(400) } });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(cutOf(f.submitted, "windows")).toBeUndefined();
    expect(f.logs.some((l) => l.code === "cgo.spend_controller_make_room_inflight")).toBe(true);
  });

  it("stale spend data or the rules switched off: no make-room cut", async () => {
    for (const extra of [{ loadSpendPace: async () => ({ ...pacedAt(400), data_fresh: false }) }, { businessRulesOff: async () => true }]) {
      const f = fake({ meta: homeServices() }, { live: 400, room: need(100), holds: { [holdKeyOf("meta", "windows")]: zaviMade(400) }, extra });
      await runSpendControllerForTenant(T, NOW, f.deps);
      expect(cutOf(f.submitted, "windows")).toBeUndefined();
    }
  });

  it("pending tests unreadable: no make-room cut, logged", async () => {
    const f = fake({ meta: homeServices() }, { live: 400, extra: { makeRoomNeed: async () => Promise.reject(new Error("db down")) } });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(cutOf(f.submitted, "windows")).toBeUndefined();
    expect(f.logs.some((l) => l.code === "cgo.spend_controller_make_room_skipped")).toBe(true);
  });

  it("must catch (SaaS, Google only): a clearly worse campaign Zavi raised is cut down toward its base, the cut sized to the test", async () => {
    const google = [gcamp("901", 9), gcamp("902", 10), gcamp("903", 11), gcamp("904", 25, { daily_budget_usd: 250 })];
    const f = fake({ google }, { live: 400, room: need(200), holds: { [holdKeyOf("google", "904")]: { held_daily_usd: 100, base_usd: 150 } } });
    await runSpendControllerForTenant(T, NOW, f.deps);
    const cut = cutOf(f.submitted, "904");
    expect(cut).toMatchObject({ exec_class: "google_ads.update_campaign_budget", channel_slug: "google_ads" });
    expect(cut?.body).toMatchObject({ daily_budget_usd: 235, expected_current_daily_budget_usd: 250, [MAKE_ROOM_TEST_KEY]: TEST_ID });
    expect(await orderBodyProblem(cut!.exec_class, cut!.body)).toBeNull();
  });
});

describe("N1: a make-room cut passes the real submit's planner check (main refuses budget orders without planner numbers)", () => {
  async function viaRealSubmit(objects: { meta?: AdObject[]; google?: AdObject[] }, live: number, room: MakeRoomNeed, holds: Record<string, ObjectHold>) {
    const results: Array<{ order: CgoAdOrderInput; r: CgoAdOrderResult }> = [];
    const f = fake(objects, {
      live,
      room,
      holds,
      extra: {
        submit: async (i: CgoAdOrderInput) => {
          const r = await submitCgoAdAction(i);
          results.push({ order: i, r });
          return r;
        },
      },
    });
    await runSpendControllerForTenant(T, NOW, f.deps);
    return results.filter((x) => x.order.body[MAKE_ROOM_TEST_KEY] !== undefined);
  }

  it("must catch (Meta-heavy marketplace): the sized 5% cut reaches the database step, its card carries the make-room planner", async () => {
    const got = await viaRealSubmit({ meta: homeServices() }, 400, need(100), { [holdKeyOf("meta", "windows")]: zaviMade(400) });
    expect(got).toHaveLength(1);
    expect(got[0]!.r).toEqual({ ok: false, why: "not_running_ads" });
    expect(got[0]!.order.planner).toMatchObject({ kind: "make_room_cut", from_usd: 400, test_id: TEST_ID, test_revision: 3, short_usd: 400 });
  });

  it("must catch (SaaS, Google only): a cut toward the base passes too", async () => {
    const google = [gcamp("901", 9), gcamp("902", 10), gcamp("903", 11), gcamp("904", 25, { daily_budget_usd: 250 })];
    const got = await viaRealSubmit({ google }, 400, need(200), { [holdKeyOf("google", "904")]: { held_daily_usd: 100, base_usd: 150 } });
    expect(got.map((x) => x.r)).toEqual([{ ok: false, why: "not_running_ads" }]);
  });

  it("a big shortfall: every capped cut passes", async () => {
    const meta = [...homeServices(), ad("gutters", 60, { daily_budget_usd: 200, spend7d_usd: 1200, settled: { spend_usd: 1200, results: 20, purchases: 0, purchase_value_usd: 0 } })];
    const got = await viaRealSubmit({ meta }, 500, need(0, { tests: [{ id: TEST_ID, revision: 1, channel: "tiktok_ads", daily_budget_usd: 250, hold_usd: 5000, created_at: "2026-10-10T00:00:00Z" }] }), {
      [holdKeyOf("meta", "windows")]: zaviMade(400),
      [holdKeyOf("meta", "gutters")]: zaviMade(200),
    });
    expect(got.map((x) => x.r.ok === false && x.r.why)).toEqual(["not_running_ads", "not_running_ads"]);
  });

  it("must not catch: a body that drifts from its planner is refused before anything is filed", async () => {
    const got = await viaRealSubmit({ meta: homeServices() }, 400, need(100), { [holdKeyOf("meta", "windows")]: zaviMade(400) });
    const base = got[0]!.order;
    const tamper = async (body: Record<string, unknown>, planner = base.planner) => submitCgoAdAction({ ...base, body: { ...base.body, ...body }, planner });
    expect((await tamper({ daily_budget_usd: 300 })).ok === false && (await tamper({ daily_budget_usd: 300 }) as { why: string }).why).toMatch(/planner_mismatch: body 300/);
    expect(await tamper({ [MAKE_ROOM_FREES_KEY]: 2000 })).toMatchObject({ ok: false, why: expect.stringMatching(/make-room frees 2000/) });
    expect(await tamper({ [MAKE_ROOM_REVISION_KEY]: 2 })).toMatchObject({ ok: false, why: "planner_mismatch: make-room test revision" });
    expect(await tamper({ [MAKE_ROOM_TEST_KEY]: "another-test" })).toMatchObject({ ok: false, why: "planner_mismatch: make-room test id" });
    expect(await tamper({}, { ...base.planner!, short_usd: 100 })).toMatchObject({ ok: false, why: expect.stringMatching(/more than the 100 the test was short/) });
    const { planner: _drop, ...bare } = base;
    expect(await submitCgoAdAction(bare)).toMatchObject({ ok: false, why: "no_planner_numbers" });
    expect(await tamper({ daily_budget_usd: 320 }, { kind: "cut", required_usd: 400, capacity_usd: 400, gap_usd: 0, from_usd: 400, step: 0.2 })).toMatchObject({ ok: false, why: "planner_mismatch: a make-room body under a cut planner" });
  });
});

describe("sizing (pure)", () => {
  const o = ad("x", 50, { daily_budget_usd: 400 });
  it("a cut frees what it takes from Zavi's part, never below the base", () => {
    expect(freedDailyUsd({ held_daily_usd: 100, base_usd: 150 }, 250, 200)).toBe(50);
    expect(freedDailyUsd({ held_daily_usd: 100, base_usd: 150 }, 250, 100)).toBe(100);
    expect(freedDailyUsd({ held_daily_usd: 0, base_usd: 0 }, 250, 200)).toBe(0);
  });
  it("overshoot avoided: the step is what the test needs when under the normal step, capped at it otherwise, floored at $5/day", () => {
    expect(sizeCut(o, zaviMade(400), 10, 0.2)).toEqual({ to: 390, freed: 10, step: 0.03 });
    expect(sizeCut(o, zaviMade(400), 500, 0.2)).toEqual({ to: 320, freed: 80, step: 0.2 });
    expect(sizeCut(ad("y", 50, { daily_budget_usd: 5.5 }), zaviMade(5.5), 50, 0.2)).toEqual({ skip: "too_small" });
    expect(sizeCut(ad("y", 50, { daily_budget_usd: 7 }), zaviMade(7), 50, 0.5)).toEqual({ to: 5, freed: 2, step: 0.29 });
    expect(sizeCut(o, undefined, 10, 0.2)).toEqual({ skip: "not_held" });
  });
  it("tests are funded oldest first; room in flight counts", () => {
    const tests = [
      { id: "new", revision: 1, channel: "reddit_ads" as const, daily_budget_usd: 10, hold_usd: 200, created_at: "2026-10-11T00:00:00Z" },
      { id: "old", revision: 1, channel: "tiktok_ads" as const, daily_budget_usd: 25, hold_usd: 500, created_at: "2026-10-09T00:00:00Z" },
    ];
    expect(shortTests({ left_usd: 300, inflight_usd: 0, tests }).map((s) => [s.test.id, s.short_usd])).toEqual([["old", 200], ["new", 200]]);
    expect(shortTests({ left_usd: 300, inflight_usd: 400, tests })).toEqual([]);
  });
  it("two short tests: each card names its own channel", () => {
    const n = need(0, {
      tests: [
        { id: "t1", revision: 1, channel: "tiktok_ads", daily_budget_usd: 5, hold_usd: 100, created_at: "2026-10-09T00:00:00Z" },
        { id: "t2", revision: 1, channel: "reddit_ads", daily_budget_usd: 5, hold_usd: 100, created_at: "2026-10-10T00:00:00Z" },
      ],
    });
    const cands = [{ o: ad("a", 50, { daily_budget_usd: 400 }), why: "worse", ratio: 3, median: 20 }, { o: ad("b", 50, { daily_budget_usd: 400 }), why: "worse", ratio: 2.5, median: 20 }];
    const plan = planMakeRoomCuts({ need: n, cands, holds: new Map([[holdKeyOf("meta", "a"), zaviMade(400)], [holdKeyOf("meta", "b"), zaviMade(400)]]), maxStep: 0.2 });
    expect(plan.orders.map((o) => [o.body.ad_set_id, o.body.daily_budget_usd, o.body[MAKE_ROOM_TEST_KEY]])).toEqual([["a", 395, "t1"], ["b", 395, "t2"]]);
    expect(plan.orders[1]!.reason).toMatch(/Reddit first test/);
    expect(plan.still_short).toEqual([]);
  });
});

describe("the gate: a make-room cut skips only the learning lock", () => {
  const cut = { kind: "ad" as const, exec_class: "meta_ads.update_ad_set_budget", payload: { ad_set_id: "123456789012345", daily_budget_usd: 380, expected_current_daily_budget_usd: 400, over_cap: false, rationale: "", [MAKE_ROOM_TEST_KEY]: TEST_ID }, source: { table: "channel_actions" as const, id: "k", run_id: null } };
  const learning: AdObjectFacts = { id: "123456789012345", conversionObjective: true, objective: "OFFSITE_CONVERSIONS", learning: true, daysSinceEdit: 2, lockDays: 7, spend7dUsd: 400, conversions7d: 5, targetCpaUsd: null, conversionEvent: "PURCHASE", conversionEventFiring: true };
  const facts = (over: Partial<UnattendedFacts>): UnattendedFacts => ({ refsResolved: true, openAdvice: "clear", goal: { present: false }, objects: [learning], trackingOk: true, founderSetBudget: false, ...over });

  it("a live test's cut on a learning ad set is allowed", () => {
    expect(evaluateUnattended(cut, facts({ makeRoomCut: true })).verdict).toBe("allow");
  });
  it("no live test (or unreadable): the cut is refused, not run under the lock", () => {
    expect(evaluateUnattended(cut, facts({ makeRoomCut: false }))).toMatchObject({ verdict: "deny", reasons: ["make_room_test_changed"] });
    expect(evaluateUnattended(cut, facts({ makeRoomCut: null }))).toMatchObject({ verdict: "deny", reasons: ["make_room_unverified"] });
  });
  it("every other protection still holds: founder-set budget, tracking, brand", () => {
    expect(evaluateUnattended(cut, facts({ makeRoomCut: true, founderSetBudget: true })).reasons).toContain("founder_set_budget");
    expect(evaluateUnattended(cut, facts({ makeRoomCut: true, trackingOk: false })).reasons).toContain("tracking_broken");
    expect(evaluateUnattended(cut, facts({ makeRoomCut: true, objects: [{ ...learning, brand: true }] })).reasons).toContain("brand_campaign");
  });
  it("never on a raise", () => {
    const raise = { ...cut, payload: { ...cut.payload, daily_budget_usd: 420 } };
    expect(evaluateUnattended(raise, facts({ makeRoomCut: true })).reasons).toContain("learning_lock");
  });
});

function pending(over: Partial<PendingTestRow> = {}): PendingTestRow {
  return {
    id: TEST_ID,
    tenant_id: T,
    channel_slug: "tiktok_ads",
    status: "pending",
    daily_budget_usd: 25,
    hold_usd: 500,
    proposal: { name: "First TikTok test", daily_budget_usd: 25 },
    action_id: null,
    hold_idem_key: null,
    closed_reason: null,
    revision: 1,
    created_at: "2026-10-10T00:00:00Z",
    expires_at: new Date(NOW.getTime() + 3 * DAY).toISOString(),
    updated_at: "2026-10-10T00:00:00Z",
    ...over,
  };
}

function claimWorld(rows: PendingTestRow[], left: number, launched = false) {
  const logs: string[] = [];
  const b: ActiveAdBudget = { id: "b1", monthly_usd: 10000, month_cap_usd: 10000, spent_usd: 5000, held_usd: 5000 - left, creator_held_usd: 0, creator_spent_usd: 0, left_usd: left, daily_limit_usd: null, next_month_start: "2026-11-01", days_left: 20, days_in_month: 31, margin: 1 };
  const deps: ClaimDeps = {
    readTests: async () => rows.map((r) => ({ ...r })),
    readBudget: async () => b,
    refile: async () => ({ kind: "filed", action_id: "6f2c4d1e-9a8b-4c7d-8e6f-0a1b2c3d4e5f" }),
    reserve: async (r, action_id): Promise<AdSpendHold> => ({ status: "held", tenant_id: T, idem_key: claimIdemKey(r.channel_slug, action_id), fresh: true }),
    readCard: async () => null,
    release: async () => "released",
    update: async (r, patch) => {
      const hit = rows.find((x) => x.id === r.id);
      if (!hit || hit.revision !== r.revision) return false;
      Object.assign(hit, patch, { revision: hit.revision + 1 });
      return true;
    },
    log: (_t, code) => logs.push(code),
    launchedSince: async () => launched,
  };
  return { deps, logs };
}

describe("an expired pending test while the channel is untried", () => {
  const expired = { expires_at: new Date(NOW.getTime() - 1).toISOString() };

  it("is renewed a week (it does not silently end), and stays a live test that keeps its room", async () => {
    const rows = [pending(expired)];
    const w = claimWorld(rows, 0);
    const out = await runPendingTestsForTenant(T, NOW, {}, w.deps);
    expect(out).toMatchObject({ renewed: 1, closed: 0 });
    expect(rows[0]).toMatchObject({ status: "pending", expires_at: new Date(NOW.getTime() + 7 * DAY).toISOString(), created_at: "2026-10-10T00:00:00Z" });
    expect(w.logs).toContain("pending_test.renewed");
  });

  it("closes once the channel launched something since it was recorded", async () => {
    const rows = [pending(expired)];
    const out = await runPendingTestsForTenant(T, NOW, {}, claimWorld(rows, 0, true).deps);
    expect(out).toMatchObject({ renewed: 0, closed: 1 });
    expect(rows[0]).toMatchObject({ status: "closed", closed_reason: "expired" });
  });

  it("closes after 28 days, and a renewal never runs past that", async () => {
    const old = pending({ ...expired, created_at: new Date(NOW.getTime() - 28 * DAY).toISOString() });
    const rows = [old];
    await runPendingTestsForTenant(T, NOW, {}, claimWorld(rows, 0).deps);
    expect(rows[0]).toMatchObject({ status: "closed", closed_reason: "expired" });
    expect(renewUntil({ created_at: new Date(NOW.getTime() - 25 * DAY).toISOString() }, NOW)).toBe(new Date(NOW.getTime() + 3 * DAY).toISOString());
  });

  it("a test whose card is already filed is not renewed (the card reserves on approval)", async () => {
    const rows = [pending({ ...expired, action_id: "6f2c4d1e-9a8b-4c7d-8e6f-0a1b2c3d4e5f" })];
    const out = await runPendingTestsForTenant(T, NOW, {}, claimWorld(rows, 0).deps);
    expect(out).toMatchObject({ renewed: 0, closed: 1 });
  });
});
