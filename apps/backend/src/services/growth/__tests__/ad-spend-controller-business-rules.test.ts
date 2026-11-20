
import { describe, it, expect, vi } from "vitest";

vi.mock("../business-control-runtime", async (orig) => ({
  ...(await orig<typeof import("../business-control-runtime")>()),
  monitorExperiments: async () => undefined,
}));
const exps = vi.hoisted(() => ({ list: [] as unknown[], fail: false }));
vi.mock("../experiment-controls", async (orig) => ({
  ...(await orig<typeof import("../experiment-controls")>()),
  readExperiments: async () => {
    if (exps.fail) throw new Error("Experiment controls are unavailable or incomplete.");
    return exps.list;
  },
}));
vi.mock("../unattended-policy", () => ({ loadPausedByFounder: vi.fn() }));

import { founderCutCandidates, runSpendControllerForTenant, dwellKeyOf, type AdObject, type ControllerDeps, type Inventory } from "../ad-spend-controller";
import { BUSINESS_CONTROL_DEFAULTS } from "../business-control-policy";
import { cutDwellKeyOf } from "../business-rules";
import { plannerProblem } from "../cgo-ad-orders";
import type { CgoAdOrderInput } from "../cgo-ad-orders";
import type { SpendPace } from "@/services/growth/spend-pace";

const T = "44444444-4444-4444-4444-444444444444";
const NOW = new Date("2026-10-12T12:00:00Z");

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
const inv = (meta: AdObject[], google: AdObject[] = []): Inventory => ({ meta: { connected: true, objects: meta, ads: [] }, google: { connected: google.length > 0, objects: google, conversions30d: google.length ? 50 : null } });
const pace = (behind: boolean): SpendPace => ({ daily_target_usd: behind ? 800 : 10, required_cumulative_usd: 1000, actual_month_usd: 900, delivery_debt_usd: behind ? 2000 : 0, days_left: 20, data_fresh: true }) as SpendPace;

function fake(meta: AdObject[], opts: { behind?: boolean; google?: AdObject[]; enableSafe?: string[]; extra?: Partial<ControllerDeps> } = {}) {
  const submitted: CgoAdOrderInput[] = [];
  const asked: string[] = [];
  let woke = 0;
  const deps = {
    cgoAdBudget: async () => ({ id: "b1" }),
    loadSpendPace: async () => pace(opts.behind ?? false),
    readMeta: async () => inv(meta).meta,
    readGoogle: async () => inv([], opts.google ?? []).google,
    ledgerCapacity: async () => null,
    metaThrottled: async () => null,
    noteMetaRateLimit: async () => undefined,
    recentOrderKeys: async () => new Set<string>(),
    enableSafe: async () => new Set(opts.enableSafe ?? []),
    cutLocked: async () => false,
    askFounder: async (_t: string, topic: string) => {
      asked.push(topic);
      return true;
    },
    submit: async (i: CgoAdOrderInput) => {
      submitted.push(i);
      return { ok: true as const, action_id: `a${submitted.length}` };
    },
    wakeCgo: async () => {
      woke += 1;
      return { woke: true };
    },
    retarget: () => ({ readWebsiteAudience: async () => null, readAdSetSetup: async () => null, readCreativeCopy: async () => null }),
    creative: () => ({ fatiguedAdSets: async () => new Set<string>(), readCreativeCopy: async () => null, generateImage: async () => null }),
    maintainHolds: async () => ({}),
    log: () => undefined,
    ...opts.extra,
  } as unknown as ControllerDeps;
  return { deps, submitted, asked, woke: () => woke };
}
const budgetOf = (s: CgoAdOrderInput[], id: string) => s.find((o) => o.body.ad_set_id === id || o.body.campaign_id === id)?.body.daily_budget_usd;
const budgetChanges = (s: CgoAdOrderInput[]) => s.filter((o) => /budget|set_status/.test(o.exec_class));

const windows = (over: Partial<AdObject> = {}) =>
  ad("windows", 50, { daily_budget_usd: 400, spend7d_usd: 1400, results7d: 28, settled: { spend_usd: 1400, results: 28, purchases: 0, purchase_value_usd: 0 }, ...over });
const cleaning = () => [ad("deep-clean", 18), ad("move-out", 20), ad("weekly", 22), windows()];

describe("cuts: clearly worse on the settled week, only out of surplus", () => {
  it("must catch (home-cleaning): an ad set at 2.5x the median with 25+ settled results is cut 20%", async () => {
    const f = fake(cleaning());
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(budgetOf(f.submitted, "windows")).toBe(320);
    expect(f.submitted.find((o) => o.body.ad_set_id === "windows")).toMatchObject({ exec_class: "meta_ads.update_ad_set_budget" });
    expect(budgetOf(f.submitted, "weekly")).toBeUndefined();
  });

  it("must catch: Meta near its rate limit still gets its cut (a cut only lowers spend); a raise there waits", async () => {
    const f = fake(cleaning(), { extra: { metaThrottled: async (_t: string, _n: Date, o?: { allowProbe?: boolean }) => (o?.allowProbe ? null : "Meta rate limit: backing off until 12:05 UTC") } });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(f.submitted.find((o) => o.body.ad_set_id === "windows")).toMatchObject({ exec_class: "meta_ads.update_ad_set_budget", body: { daily_budget_usd: 320 } });
    expect(f.submitted.filter((o) => o.exec_class.startsWith("meta_ads.") && Number(o.body.daily_budget_usd) > Number(o.body.expected_current_daily_budget_usd))).toEqual([]);
  });

  it("must catch (SaaS): the same rules on a sign-up event", async () => {
    const f = fake([ad("trial-a", 9), ad("trial-b", 10), ad("trial-c", 11), ad("trial-wide", 25, { daily_budget_usd: 200 })]);
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(budgetOf(f.submitted, "trial-wide")).toBe(160);
  });

  it("must not catch (SaaS): a 2-ad account where both ads are profitable is never cut", async () => {
    const f = fake([ad("trial-a", 10, { daily_budget_usd: 400 }), ad("trial-b", 30, { daily_budget_usd: 400 })]);
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(budgetChanges(f.submitted)).toEqual([]);
  });

  it("must not catch: a cut that would drop live capacity under what the month needs is not filed", async () => {
    const full = [...cleaning().slice(0, 3), windows({ spend3d_usd: 1200 })];
    const tight = { loadSpendPace: async () => ({ ...pace(false), daily_target_usd: 650 / 1.2 }) };
    const f = fake(full, { extra: tight });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(budgetOf(f.submitted, "windows")).toBeUndefined();
    const roomy = fake(full);
    await runSpendControllerForTenant(T, NOW, roomy.deps);
    expect(budgetOf(roomy.submitted, "windows")).toBe(320);
  });

  it("must not catch: an ad set still learning (or edited recently) gets no cut, and no hourly question", async () => {
    const f = fake(cleaning(), { extra: { cutLocked: async (_t: string, o: AdObject) => o.id === "windows" } });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(budgetOf(f.submitted, "windows")).toBeUndefined();
    expect(f.asked).toEqual([]);
  });

  it("must not catch: under 20 settled results, zero results, under 5 spend days, or under 7 days old", async () => {
    const cases: Array<Partial<AdObject>> = [
      { settled: { spend_usd: 700, results: 14, purchases: 0, purchase_value_usd: 0 }, results7d: 14 },
      { settled: { spend_usd: 700, results: 0, purchases: 0, purchase_value_usd: 0 }, results7d: 0 },
      { spend_days7d: 4 },
      { created_at: "2026-10-08T00:00:00Z" },
    ];
    for (const over of cases) {
      const f = fake([...cleaning().slice(0, 3), windows(over)]);
      await runSpendControllerForTenant(T, NOW, f.deps);
      expect(budgetOf(f.submitted, "windows")).toBeUndefined();
    }
  });

  it("an object cut in the last 7 days is not cut again (its own dwell key)", async () => {
    const f = fake(cleaning(), { extra: { recentOrderKeys: async (_t: string, _n: Date, hours: number) => new Set(hours >= 168 ? [cutDwellKeyOf("meta", "windows")] : []) } });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(budgetOf(f.submitted, "windows")).toBeUndefined();
  });

  it("a cut the executor refused for good is not filed again the next hour", async () => {
    const f = fake(cleaning(), { extra: { orderBackoffs: async () => [{ dwell_key: cutDwellKeyOf("meta", "windows"), why: "body invalid", failed_at: NOW.toISOString(), fresh: false }] } });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(budgetOf(f.submitted, "windows")).toBeUndefined();
  });

  it("a loser too small to cut under $5/day gets one question to pause or consolidate, never an auto-pause", async () => {
    const f = fake([...cleaning().slice(0, 3), windows({ daily_budget_usd: 6 })]);
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(budgetChanges(f.submitted).filter((o) => o.body.ad_set_id === "windows" || o.body.object_id === "windows")).toEqual([]);
    expect(f.asked).toEqual(["cut_floor:meta:windows"]);
  });

  it("never cut: a campaign budget over live retargeting, brand, or traffic", async () => {
    const camp = ad("cbo", 50, { level: "campaign", campaign_id: "cbo", daily_budget_usd: 400 });
    const rt = ad("rt", 50, { campaign_id: "cbo", budget_on_campaign: true, daily_budget_usd: null, audience_ids: ["visitors"] });
    const traffic = ad("blog", 50, { result_kind: "clicks", daily_budget_usd: 400 });
    const f = fake([...cleaning().slice(0, 3), camp, rt, traffic]);
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(budgetOf(f.submitted, "cbo")).toBeUndefined();
    expect(budgetOf(f.submitted, "blog")).toBeUndefined();
  });

  it("must catch: Google's cheap cost per result does not drag Meta's median (cut judged per platform)", async () => {
    const g = (id: string) => ad(id, 2, { platform: "google", level: "campaign", campaign_id: id });
    const f = fake(cleaning(), { google: [g("771"), g("772"), g("773"), g("774"), g("775")] });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(budgetOf(f.submitted, "windows")).toBe(320);
    expect(budgetOf(f.submitted, "weekly")).toBeUndefined();
    expect(budgetOf(f.submitted, "deep-clean")).toBeUndefined();
  });
});

describe("raises: the band, per platform, 20% steps", () => {
  it("must not catch: a $40/day ad set with 6 results at 1.4x the median is still raised 20%", async () => {
    const small = ad("starter", 28, { daily_budget_usd: 40, spend7d_usd: 168, results7d: 6, spend3d_usd: 120, spend_days7d: 4, created_at: "2026-10-08T00:00:00Z" });
    const f = fake([ad("deep-clean", 18), ad("move-out", 20), ad("weekly", 22), small], { behind: true });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(budgetOf(f.submitted, "starter")).toBe(48);
    expect(budgetOf(f.submitted, "deep-clean")).toBe(120);
  });

  it("must catch: Google's cheap cost per result does not push a Meta ad out of the band", async () => {
    const g = (id: string) => ad(id, 2, { platform: "google", level: "campaign", campaign_id: id });
    const f = fake([ad("deep-clean", 18), ad("move-out", 20)], { behind: true, google: [g("771"), g("772"), g("773")] });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(budgetOf(f.submitted, "move-out")).toBe(120);
  });

  it("the off switch: the older +100% raise, one mixed median, and no cuts", async () => {
    const f = fake(cleaning(), { extra: { businessRulesOff: async () => true } });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(budgetOf(f.submitted, "windows")).toBeUndefined();
    const g = fake([ad("deep-clean", 18)], { behind: true, extra: { businessRulesOff: async () => true } });
    await runSpendControllerForTenant(T, NOW, g.deps);
    expect(budgetOf(g.submitted, "deep-clean")).toBe(200);
  });

  it("an off-switch read that fails keeps the rules on", async () => {
    const f = fake(cleaning(), { extra: { businessRulesOff: async () => Promise.reject(new Error("db down")) } });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(budgetOf(f.submitted, "windows")).toBe(320);
  });

  it("stale spend data: no cut", async () => {
    const f = fake(cleaning(), { extra: { loadSpendPace: async () => ({ ...pace(false), data_fresh: false }) } });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(budgetOf(f.submitted, "windows")).toBeUndefined();
  });
});

describe("a saved, enabled business policy no longer replaces the controller", () => {
  const saved = (over: Partial<typeof BUSINESS_CONTROL_DEFAULTS> = {}) => ({ ...BUSINESS_CONTROL_DEFAULTS, enabled: true, max_cpa_usd: 30, revision: 1, updated_at: NOW.toISOString(), ...over });
  const withPolicy = (policy: ReturnType<typeof saved>) => ({
    businessPolicy: async () => policy,
    trackingOk: async () => true,
    goalMode: async () => ({ ok: true as const, mode: "count" as const, metric: "bookings" }),
  });
  const bookings = (id: string, cprUsd: number, over: Partial<AdObject> = {}) => {
    const n = Math.round(700 / cprUsd);
    return ad(id, cprUsd, { purchases7d: n, settled: { spend_usd: 700, results: n, purchases: n, purchase_value_usd: 0 }, ...over });
  };

  it("its max CPA is the cut line, at its own 10% step", async () => {
    const f = fake([bookings("good", 20), bookings("solid", 24), bookings("ok", 26), bookings("steady", 34, { daily_budget_usd: 1000 })], { extra: withPolicy(saved({ step_percent: 10 })) });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(budgetOf(f.submitted, "steady")).toBe(900);
  });

  it("its 10% step bounds a raise, and Zavi's own paused launch is still switched on (no early return)", async () => {
    const ready = bookings("new-launch", 20, { active: false, paused_self: true, spend7d_usd: 0, spend3d_usd: 0, results7d: 0, purchases7d: 0, settled: undefined });
    const f = fake([bookings("good", 20), ready], { behind: true, enableSafe: [dwellKeyOf("meta", "new-launch")], extra: withPolicy(saved({ step_percent: 10 })) });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(budgetOf(f.submitted, "good")).toBe(110);
    expect(f.submitted.some((o) => o.exec_class === "meta_ads.set_status" && o.body.object_id === "new-launch" && o.body.status === "ACTIVE")).toBe(true);
  });

  it("must not catch: a cut its gate would hold is never filed (settled week over the limit, the last 7 days within it)", async () => {
    const recovered = bookings("steady", 34, { daily_budget_usd: 1000, results7d: 70, purchases7d: 70 });
    const f = fake([bookings("good", 20), bookings("solid", 24), bookings("ok", 26), recovered], { extra: withPolicy(saved()) });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(budgetOf(f.submitted, "steady")).toBeUndefined();
  });

  it("must not catch: only the policy's own winners are raised (its gate would hold any other)", async () => {
    const f = fake([bookings("good", 25), bookings("near", 34)], { behind: true, extra: withPolicy(saved()) });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(budgetOf(f.submitted, "good")).toBe(120);
    expect(budgetOf(f.submitted, "near")).toBeUndefined();
  });

  it("must not catch: peers the policy cannot judge yet do not make up the three", async () => {
    const young = (id: string) => bookings(id, 20, { created_at: "2026-10-09T00:00:00Z" });
    const f = fake([young("new-a"), young("new-b"), young("new-c"), bookings("steady", 34, { daily_budget_usd: 1000 })], { extra: withPolicy(saved()) });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(budgetOf(f.submitted, "steady")).toBeUndefined();
  });

  it("the off switch with a saved policy: one mixed median again (only the saved step still bounds a raise)", async () => {
    const g = (id: string) => bookings(id, 2, { platform: "google", level: "campaign", campaign_id: id });
    const extra = { ...withPolicy(saved({ step_percent: 10 })), businessRulesOff: async () => true };
    const f = fake([bookings("good", 20)], { behind: true, google: [g("771"), g("772"), g("773")], extra });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(budgetOf(f.submitted, "good")).toBeUndefined();
  });

  it("must not catch: a campaign budget over a traffic ad set is not raised as the policy's winner (its gate reads it as clicks)", async () => {
    const camp = bookings("cbo", 20, { level: "campaign", campaign_id: "cbo" });
    const trafficChild = ad("blog", 2, { campaign_id: "cbo", result_kind: "clicks", budget_on_campaign: true, daily_budget_usd: null });
    const f = fake([camp, trafficChild], { behind: true, extra: withPolicy(saved()) });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(budgetOf(f.submitted, "cbo")).toBeUndefined();
  });

  it("a saved step above 20% is held to 20%", async () => {
    const f = fake([bookings("good", 20)], { behind: true, extra: withPolicy(saved({ step_percent: 50 })) });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(budgetOf(f.submitted, "good")).toBe(120);
  });

  it("its automatic stops pause a loser", async () => {
    const f = fake([bookings("good", 20), bookings("solid", 24), bookings("ok", 26), bookings("bad", 70)], { extra: withPolicy(saved({ automatic_stops: true })) });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(f.submitted.find((o) => o.body.object_id === "bad")?.body.status).toBe("PAUSED");
  });

  it("never pauses or cuts a loser whose ads Meta stopped: it is judged once it can run again", async () => {
    const stuck = bookings("bad", 70, { has_any_ads: true, has_live_ads: false });
    const f = fake([bookings("good", 20), bookings("solid", 24), bookings("ok", 26), stuck], { extra: withPolicy(saved({ automatic_stops: true })) });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(f.submitted.some((o) => o.body.object_id === "bad" || o.body.ad_set_id === "bad")).toBe(false);
  });

  it("a cap that qualifies nobody still leaves the wake: the leftover gap wakes cgo", async () => {
    const f = fake([bookings("pricey", 60)], { behind: true, extra: withPolicy(saved({ max_cpa_usd: 5 })) });
    const out = await runSpendControllerForTenant(T, NOW, f.deps);
    expect(out).toMatchObject({ outcome: "ran", woke_cgo: true });
  });
});

describe("planner numbers (gaps E): every budget order the controller files matches its own numbers", () => {
  it("raises (home-cleaning, behind pace) and cuts (SaaS, surplus) all carry numbers that give their amount", async () => {
    const behind = fake([ad("deep-clean", 18), ad("move-out", 20), ad("weekly", 22, { daily_budget_usd: 333 })], { behind: true });
    await runSpendControllerForTenant(T, NOW, behind.deps);
    const cutting = fake([ad("trial-a", 9), ad("trial-b", 10), ad("trial-c", 11), ad("trial-wide", 25, { daily_budget_usd: 333 })]);
    await runSpendControllerForTenant(T, NOW, cutting.deps);
    const budgetOrders = [...behind.submitted, ...cutting.submitted].filter((o) => typeof o.body.daily_budget_usd === "number");
    expect(budgetOrders.length).toBeGreaterThan(2);
    for (const o of budgetOrders) expect(plannerProblem(o.exec_class, o.body, o.planner)).toBeNull();
    expect(cutting.submitted.find((o) => o.body.ad_set_id === "trial-wide")?.planner).toMatchObject({ kind: "cut", from_usd: 333, median_cpr_usd: 10 });
  });

  it("must not catch: an ordinary 20% raise of a $33.33 budget is not refused for rounding", async () => {
    const f = fake([ad("deep-clean", 18, { daily_budget_usd: 33.33, spend7d_usd: 233.31, spend3d_usd: 99.99 })], { behind: true });
    await runSpendControllerForTenant(T, NOW, f.deps);
    const raise = f.submitted.find((o) => o.body.ad_set_id === "deep-clean")!;
    expect(raise.body.daily_budget_usd).toBe(40);
    expect(plannerProblem(raise.exec_class, raise.body, raise.planner)).toBeNull();
  });
});

describe("founderCutCandidates (find the money elsewhere, plan 2026-10-23 Task 3.1)", () => {
  const saved = (over: Partial<typeof BUSINESS_CONTROL_DEFAULTS> = {}) => ({ ...BUSINESS_CONTROL_DEFAULTS, enabled: true, max_cpa_usd: 30, revision: 1, updated_at: NOW.toISOString(), ...over });
  const bookings = (id: string, cprUsd: number, over: Partial<AdObject> = {}) => {
    const n = Math.round(700 / cprUsd);
    return ad(id, cprUsd, { purchases7d: n, settled: { spend_usd: 700, results: n, purchases: n, purchase_value_usd: 0 }, ...over });
  };

  it("the make-room judge on the inventory read now: the clearly worse ad, the rule step", async () => {
    const r = await founderCutCandidates(T, NOW, fake(cleaning()).deps);
    expect(r.cands.map((c) => c.o.id)).toEqual(["windows"]);
    expect(r.step).toBe(0.2);
  });

  it("must-catch: a real saved policy is passed (its cut line and its own step), judged on the founder's goal", async () => {
    const extra = { businessPolicy: async () => saved({ step_percent: 10 }), trackingOk: async () => true, goalMode: async () => ({ ok: true as const, mode: "count" as const, metric: "bookings" }) };
    const r = await founderCutCandidates(T, NOW, fake([bookings("good", 20), bookings("solid", 24), bookings("ok", 26), bookings("steady", 34, { daily_budget_usd: 1000 })], { extra }).deps);
    expect(r.cands.map((c) => c.o.id)).toEqual(["steady"]);
    expect(r.step).toBe(0.1);
  });

  it("a platform that cannot be read offers nothing and marks the list incomplete; an object ordered in the last day is left out", async () => {
    const unread = await founderCutCandidates(T, NOW, fake(cleaning(), { extra: { readMeta: async () => Promise.reject(new Error("meta down")) } }).deps);
    expect(unread).toMatchObject({ cands: [], incomplete: true });
    expect((await founderCutCandidates(T, NOW, fake(cleaning()).deps)).incomplete).toBe(false);
    const recent = await founderCutCandidates(T, NOW, fake(cleaning(), { extra: { recentOrderKeys: async () => new Set([dwellKeyOf("meta", "windows")]) } }).deps);
    expect(recent.cands).toEqual([]);
  });

  it("must-catch (Codex F3): an active or settling experiment's object is never offered, even with saved controls switched off", async () => {
    const off = { businessPolicy: async () => saved({ enabled: false, reporting_delay_hours: 48 }) };
    exps.list = [{ id: "e1", platform: "meta", object_id: "windows", stopped_at: null }];
    try {
      expect((await founderCutCandidates(T, NOW, fake(cleaning(), { extra: off }).deps)).cands).toEqual([]);
      exps.list = [{ id: "e1", platform: "meta", object_id: "windows", stopped_at: new Date(NOW.getTime() - 60 * 3_600_000).toISOString() }];
      expect((await founderCutCandidates(T, NOW, fake(cleaning(), { extra: off }).deps)).cands).toEqual([]);
      exps.list = [{ id: "e1", platform: "meta", object_id: "windows", stopped_at: new Date(NOW.getTime() - 100 * 3_600_000).toISOString() }];
      expect((await founderCutCandidates(T, NOW, fake(cleaning(), { extra: off }).deps)).cands.map((c) => c.o.id)).toEqual(["windows"]);
      exps.list = [{ id: "e1", platform: "meta", object_id: "windows", stopped_at: null }];
      expect((await founderCutCandidates(T, NOW, fake(cleaning()).deps)).cands).toEqual([]);
    } finally {
      exps.list = [];
    }
  });

  it("must-catch (Codex re-check F2): an experiment read that fails throws (find_money unreadable), never an empty list", async () => {
    exps.fail = true;
    try {
      await expect(founderCutCandidates(T, NOW, fake(cleaning()).deps)).rejects.toThrow(/Experiment controls/);
    } finally {
      exps.fail = false;
    }
  });

  it("an unreadable goal throws (judging on the wrong result offers the wrong cuts)", async () => {
    await expect(founderCutCandidates(T, NOW, fake(cleaning(), { extra: { goalMode: async () => Promise.reject(new Error("db")) } }).deps)).rejects.toThrow(/goal/);
  });
});
