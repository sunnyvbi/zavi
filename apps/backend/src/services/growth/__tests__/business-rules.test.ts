
import { describe, it, expect } from "vitest";
import { budgetHolder, cutCandidates, cutOrders, cuttable, CUT_BAND, MIN_PEERS, RULE_STEP, settledCpr } from "../business-rules";
import { resultBasis, type AdObject } from "../ad-spend-controller";

const NOW = new Date("2026-10-12T12:00:00Z");

function ad(id: string, cprUsd: number, over: Partial<AdObject> = {}, spend = 700): AdObject {
  const results = Math.round(spend / cprUsd);
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
    spend7d_usd: spend,
    spend3d_usd: spend * (3 / 7),
    spend_days7d: 7,
    results7d: results,
    result_kind: "conversions",
    settled: { spend_usd: spend, results, purchases: 0, purchase_value_usd: 0 },
    has_live_ads: true,
    has_any_ads: true,
    has_ready_ads: true,
    audience_ids: [],
    created_at: "2026-09-01T00:00:00Z",
    ...over,
  };
}
const cands = (objects: AdObject[], skip: Set<string> = new Set()) =>
  cutCandidates({ objects, yardstick: objects, now: NOW, basisOf: resultBasis, protectedIds: new Set(), skip });
const peers = () => [ad("trial-a", 9), ad("trial-b", 10), ad("trial-c", 11)];
const loser = (over: Partial<AdObject> = {}) => ad("trial-wide", 25, { daily_budget_usd: 200, ...over }, 1400);

describe("cut candidates", () => {
  it("must catch (SaaS): over 2x the median of 3 peers with 20+ settled results", () => {
    const c = cands([...peers(), loser()]);
    expect(c.map((x) => x.o.id)).toEqual(["trial-wide"]);
    expect(c[0]!.ratio).toBeCloseTo(2.5);
  });

  it("must not catch: at 2x or under, under 20 settled results, zero results, fewer than 3 peers", () => {
    expect(cands([...peers(), ad("trial-x", 20, { daily_budget_usd: 200 }, 1400)])).toEqual([]);
    expect(cands([...peers(), ad("trial-thin", 50, { daily_budget_usd: 200 }, 950)])).toEqual([]);
    expect(cands([...peers(), loser({ settled: { spend_usd: 1400, results: 0, purchases: 0, purchase_value_usd: 0 } })])).toEqual([]);
    expect(cands([...peers().slice(0, MIN_PEERS - 1), loser()])).toEqual([]);
  });

  it("must not catch (home-cleaning): a 2-ad account where both ads are profitable", () => {
    expect(cands([ad("deep-clean", 10, {}, 2000), ad("move-out", 40, {}, 2000)])).toEqual([]);
  });

  it("peers are per platform: cheap Google campaigns do not make a Meta ad clearly worse", () => {
    const g = (id: string) => ad(id, 2, { platform: "google", level: "campaign", campaign_id: id });
    expect(cands([...peers(), ad("trial-d", 12, {}, 1400), g("1"), g("2"), g("3")])).toEqual([]);
  });

  it("the judgement is on the settled week, not the last 7 days", () => {
    const recovering = loser({ results7d: 140 });
    expect(cands([...peers(), recovering]).map((x) => x.o.id)).toEqual(["trial-wide"]);
    expect(settledCpr(recovering)).toBe(25);
  });

  it("a cut in the last 7 days, a young ad, or one with spend on under 5 days is not a candidate", () => {
    expect(cands([...peers(), loser()], new Set(["cut:meta:trial-wide"]))).toEqual([]);
    expect(cands([...peers(), loser({ created_at: "2026-10-08T00:00:00Z" })])).toEqual([]);
    expect(cands([...peers(), loser({ spend_days7d: 4 })])).toEqual([]);
  });

  it(`clearly worse is over ${CUT_BAND}x`, () => expect(CUT_BAND).toBe(2));
});

describe("never cut", () => {
  it("brand, retargeting, awareness or traffic, an ad set under a campaign budget, a protected campaign", () => {
    expect(cuttable(ad("x", 40, { brand: true }))).toBe(false);
    expect(cuttable(ad("x", 40, { audience_ids: ["aud"] }))).toBe(false);
    expect(cuttable(ad("x", 40, { result_kind: "clicks" }))).toBe(false);
    expect(cuttable(ad("x", 40, { budget_on_campaign: true, daily_budget_usd: null }))).toBe(false);
    expect(cuttable(ad("camp", 40, { level: "campaign", campaign_id: "camp" }), new Set(["camp"]))).toBe(false);
    expect(budgetHolder(ad("child", 40, { budget_on_campaign: true, daily_budget_usd: null }))).toBe(false);
  });
});

describe("cut orders", () => {
  const full = (o: AdObject, b: number) => b;
  it("20% off, only out of surplus; the next one waits when the surplus runs out", () => {
    const c = cands([...peers(), loser(), ad("trial-wider", 30, { daily_budget_usd: 300 }, 1400)]);
    expect(c.map((x) => x.o.id)).toEqual(["trial-wider", "trial-wide"]);
    const r = cutOrders(c, { step: RULE_STEP, stops: false, surplus: 70, capacityAt: full });
    expect(r.orders.map((o) => [o.body.ad_set_id, o.body.daily_budget_usd])).toEqual([["trial-wider", 240]]);
    expect(r.orders[0]).toMatchObject({ adds_usd: 0, dwell_key: "cut:meta:trial-wider", body: { expected_current_daily_budget_usd: 300 } });
  });

  it("never under $5/day: a loser that would need to is handed back instead", () => {
    const c = cands([...peers(), loser({ daily_budget_usd: 6 })]);
    const r = cutOrders(c, { step: RULE_STEP, stops: false, surplus: 1000, capacityAt: full });
    expect(r.orders).toEqual([]);
    expect(r.tooSmall.map((x) => x.o.id)).toEqual(["trial-wide"]);
  });

  it("a saved policy's automatic stops pause the loser", () => {
    const c = cands([...peers(), loser()]);
    const r = cutOrders(c, { step: RULE_STEP, stops: true, surplus: 1000, capacityAt: full });
    expect(r.orders[0]?.body).toMatchObject({ object_id: "trial-wide", status: "PAUSED" });
    expect(r.orders[0]?.planner).toMatchObject({ kind: "stop" });
    expect(r.orders[0]?.planner).not.toHaveProperty("from_usd");
  });

  it("a Google campaign is cut on the campaign", () => {
    const g = (id: string, cpr: number, over: Partial<AdObject> = {}) => ad(id, cpr, { platform: "google", level: "campaign", campaign_id: id, ...over }, 1400);
    const c = cands([g("771", 9), g("772", 10), g("773", 11), g("774", 25, { daily_budget_usd: 200 })]);
    expect(cutOrders(c, { step: RULE_STEP, stops: false, surplus: 1000, capacityAt: full }).orders[0]).toMatchObject({ exec_class: "google_ads.update_campaign_budget", body: { campaign_id: "774", daily_budget_usd: 160 } });
  });
});
