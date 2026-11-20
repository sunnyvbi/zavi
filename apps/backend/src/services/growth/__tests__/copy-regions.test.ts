
import { describe, it, expect, vi, beforeEach } from "vitest";

const topOrderLocations = vi.fn();
vi.mock("@/services/ad-locations/service", () => ({ topOrderLocations: (...a: unknown[]) => topOrderLocations(...a) }));
const businessCountry = vi.fn();
vi.mock("@/services/ad-locations/country", () => ({ businessCountry: (...a: unknown[]) => businessCountry(...a) }));
const resolvePlaceDetailed = vi.fn();
const readGooglePlaces = vi.fn();
vi.mock("@/services/ad-locations/places", async (orig) => ({
  ...(await orig<typeof import("@/services/ad-locations/places")>()),
  resolvePlaceDetailed: (...a: unknown[]) => resolvePlaceDetailed(...a),
  readGooglePlaces: (...a: unknown[]) => readGooglePlaces(...a),
}));
const gadsSearch = vi.fn();
const fbGetAllPages = vi.fn();
vi.mock("@/services/tools/meta-ads/_client", () => ({ metaAdsCreds: async () => ({ ad_account_id: "act_1" }), fbGetAllPages: (...a: unknown[]) => fbGetAllPages(...a) }));
vi.mock("@/services/tools/google-ads/_client", () => ({ gadsSearch: (...a: unknown[]) => gadsSearch(...a) }));

import { US_STATE_CODES } from "@/services/ad-locations/places";
import {
  ANY_GOAL,
  _resetCopyRegionCache,
  coveredGoals,
  googleGoalKeys,
  loadCopyRegions,
  metaCoverage,
  metaGoalKey,
  pickCopyRegion,
  placesOfMetaGeo,
  reaches,
  recheckRegionCopy,
  defaultRecheckReads,
  type CopyRegion,
  type RecheckReads,
  type NamedPlace,
} from "../copy-regions";
import type { AdObject, Inventory } from "../ad-spend-controller";

const T = "11111111-1111-1111-1111-111111111111";
const NOW = new Date("2026-10-11T12:00:00Z");

function adSet(id: string, over: Partial<AdObject> = {}): AdObject {
  return {
    platform: "meta",
    level: "ad_set",
    id,
    campaign_id: "c1",
    name: id,
    active: true,
    paused_self: false,
    parent_active: true,
    daily_budget_usd: 40,
    budget_on_campaign: false,
    spend7d_usd: 280,
    spend3d_usd: 120,
    spend_days7d: 7,
    results7d: 20,
    result_kind: "conversions",
    has_live_ads: true,
    has_any_ads: true,
    has_ready_ads: true,
    audience_ids: [],
    created_at: "2026-08-01T00:00:00Z",
    ...over,
  };
}
const state = (name: string): NamedPlace => ({ kind: "state", country: "US", name });
const city = (name: string, st: string): NamedPlace => ({ kind: "city", country: "US", name, state: st });

describe("metaGoalKey / googleGoalKeys: the result an ad is after", () => {
  it("names a conversion goal by its event, and awareness/traffic as such", () => {
    expect(metaGoalKey("OFFSITE_CONVERSIONS", { custom_event_type: "PURCHASE" })).toBe("event:PURCHASE");
    expect(metaGoalKey("VALUE", { custom_event_type: "PURCHASE" })).toBe("event:PURCHASE");
    expect(metaGoalKey("OFFSITE_CONVERSIONS", { custom_event_type: "COMPLETE_REGISTRATION" })).toBe("event:COMPLETE_REGISTRATION");
    expect(metaGoalKey("REACH", null)).toBe("awareness");
    expect(metaGoalKey("LANDING_PAGE_VIEWS", null)).toBe("traffic");
    expect(metaGoalKey(undefined, null)).toBeNull();
    expect(metaGoalKey("OFFSITE_CONVERSIONS", null)).toBeNull();
    expect(metaGoalKey("OFFSITE_CONVERSIONS", { custom_conversion_id: "88", custom_event_type: "PURCHASE" })).toBe("event:PURCHASE");
    expect(metaGoalKey("OFFSITE_CONVERSIONS", { custom_conversion_id: "88" })).toBeNull();
  });
  it("maps Google bidding and conversion categories onto the same words; unknown is any goal", () => {
    expect(googleGoalKeys("MAXIMIZE_CONVERSIONS", ["PURCHASE"])).toEqual(["event:PURCHASE"]);
    expect(googleGoalKeys("TARGET_CPA", ["SIGNUP"])).toEqual(["event:COMPLETE_REGISTRATION"]);
    expect(googleGoalKeys("MAXIMIZE_CLICKS", ["PURCHASE"])).toEqual(["traffic"]);
    expect(googleGoalKeys("MAXIMIZE_CONVERSIONS", [])).toEqual([ANY_GOAL]);
    expect(googleGoalKeys("SOMETHING_NEW", ["PURCHASE"])).toEqual([ANY_GOAL]);
  });
});

describe("reaches: a place, or its state or country", () => {
  it("a state reaches a city inside it; a country reaches everything in it; a state code matches its name", () => {
    expect(reaches([state("Northfield")], city("Brookvale", "Northfield"), US_STATE_CODES)).toBe(true);
    expect(reaches([{ kind: "country", country: "US" }], state("Northfield"), US_STATE_CODES)).toBe(true);
    expect(reaches([state("TX")], state("Texas"), US_STATE_CODES)).toBe(true);
  });
  it("the same Meta place by key reaches it; a nameless place, or a country group, reaches everything (fail closed)", () => {
    expect(reaches([{ kind: "state", country: "US", key: "11" }], { ...state("Northfield"), key: "11" }, US_STATE_CODES)).toBe(true);
    expect(reaches([{ kind: "state", country: "US", key: "12" }], { ...state("Northfield"), key: "11" }, US_STATE_CODES)).toBe(false);
    expect(reaches([{ kind: "city", country: "US", key: "12" }], { ...state("Northfield"), key: "11" }, US_STATE_CODES)).toBe(true);
    expect(placesOfMetaGeo({ country_groups: ["worldwide"] } as never)).toBe("everywhere");
    expect(placesOfMetaGeo({ cities: [{}] })).toBe("everywhere");
    expect(placesOfMetaGeo({ some_new_shape: [{ key: "1" }] } as never)).toBe("everywhere");
    expect(reaches(placesOfMetaGeo({ custom_locations: [{ latitude: 1, longitude: 2 }] } as never), state("Northfield"), US_STATE_CODES)).toBe(false);
    const market = placesOfMetaGeo({ geo_markets: [{ key: "DMA:500" }] } as never);
    expect(reaches(market, city("Brookvale", "Northfield"), US_STATE_CODES)).toBe(true);
    expect(reaches(market, state("Northfield"), US_STATE_CODES)).toBe(false);
  });

  it("a city does not reach its whole state; another country reaches nothing here", () => {
    expect(reaches([city("Brookvale", "Northfield")], state("Northfield"), US_STATE_CODES)).toBe(false);
    expect(reaches([{ kind: "country", country: "CA" }], state("Northfield"), US_STATE_CODES)).toBe(false);
  });
});

describe("the same-goal rule (home-cleaning service, its result a purchase)", () => {
  const region: NamedPlace = city("Brookvale", "Northfield");
  it("must catch: only an awareness ad set and another-event ad set reach the region, so a purchase copy may go there", () => {
    const coverage = metaCoverage([
      adSet("brand-awareness", { goal: "awareness", geo: { regions: [{ key: "1", name: "Northfield", country: "US" }] } }),
      adSet("cleaner-signups", { goal: "event:COMPLETE_REGISTRATION", geo: { regions: [{ key: "1", name: "Northfield", country: "US" }] } }),
      adSet("deep-clean", { goal: "event:PURCHASE", geo: { regions: [{ key: "2", name: "Westmoor", country: "US" }] } }),
    ]);
    const goals = coveredGoals(region, coverage, US_STATE_CODES);
    expect(goals).toEqual(["awareness", "event:COMPLETE_REGISTRATION"]);
    const r: CopyRegion = { label: "Brookvale", share: 0.3, place: region, meta: { type: "city", key: "77" }, covered_goals: goals };
    expect(pickCopyRegion("event:PURCHASE", [r], new Set())?.label).toBe("Brookvale");
  });

  it("must not catch: a purchase ad set reaches the region through its state, so no copy there", () => {
    const coverage = metaCoverage([adSet("deep-clean-northfield", { goal: "event:PURCHASE", geo: { regions: [{ key: "1", name: "Northfield", country: "US" }] } })]);
    const r: CopyRegion = { label: "Brookvale", share: 0.3, place: region, meta: { type: "city", key: "77" }, covered_goals: coveredGoals(region, coverage, US_STATE_CODES) };
    expect(pickCopyRegion("event:PURCHASE", [r], new Set())).toBeNull();
  });

  it("must not catch: a purchase ad set across the whole country reaches every region", () => {
    const coverage = metaCoverage([adSet("national", { goal: "event:PURCHASE", geo: { countries: ["US"] } })]);
    expect(coveredGoals(state("Northfield"), coverage, US_STATE_CODES)).toEqual(["event:PURCHASE"]);
  });

  it("a purchase ad set with no ad that can show does not block a copy", () => {
    const coverage = metaCoverage([adSet("paused-ads", { goal: "event:PURCHASE", has_live_ads: false, geo: { regions: [{ key: "1", name: "Northfield", country: "US" }] } })]);
    expect(coveredGoals(state("Northfield"), coverage, US_STATE_CODES)).toEqual([]);
  });

  it("an ad set whose goal or places were not read reaches every goal everywhere (fail closed)", () => {
    const coverage = metaCoverage([adSet("unknown", { goal: null, geo: null })]);
    const goals = coveredGoals(state("Northfield"), coverage, US_STATE_CODES);
    expect(goals).toEqual([ANY_GOAL]);
    expect(pickCopyRegion("event:PURCHASE", [{ label: "Northfield", share: 1, place: state("Northfield"), meta: { type: "region", key: "1" }, covered_goals: goals }], new Set())).toBeNull();
  });

  it("biggest order share first; one copy per goal and region in an hour", () => {
    const a: CopyRegion = { label: "A", share: 0.2, place: state("A"), meta: { type: "region", key: "1" }, covered_goals: [] };
    const b: CopyRegion = { label: "B", share: 0.5, place: state("B"), meta: { type: "region", key: "2" }, covered_goals: [] };
    expect(pickCopyRegion("event:PURCHASE", [a, b], new Set())?.label).toBe("B");
    expect(pickCopyRegion("event:PURCHASE", [a, b], new Set(["event:PURCHASE|region:2"]))?.label).toBe("A");
    expect(pickCopyRegion(null, [a, b], new Set())).toBeNull();
  });
});

describe("loadCopyRegions (SaaS with sign-ups, plus Google)", () => {
  beforeEach(() => {
    _resetCopyRegionCache();
    topOrderLocations.mockReset().mockResolvedValue([
      { label: "Northfield", share: 0.6 },
      { label: "Westmoor", share: 0.4 },
    ]);
    businessCountry.mockReset().mockResolvedValue({ code: "US", name: "United States" });
    resolvePlaceDetailed.mockReset().mockImplementation(async (_t: string, _p: string, label: string) => ({
      status: "resolved",
      place: { id: label === "Northfield" ? "region:11" : "region:22", name: `${label}, United States`, kind: "State" },
    }));
    readGooglePlaces.mockReset().mockResolvedValue(new Map([[21170, { id: "21170", name: "Westmoor", kind: "State", country_code: "US" }]]));
    gadsSearch.mockReset().mockImplementation(async (_t: string, q: string) => {
      if (q.includes("FROM campaign_conversion_goal")) return [{ campaign: { id: "501" }, campaignConversionGoal: { category: "SIGNUP", biddable: true } }];
      if (q.includes("FROM campaign_criterion")) return [{ campaign: { id: "501" }, campaignCriterion: { location: { geoTargetConstant: "geoTargetConstants/21170" } } }];
      return [{ campaign: { id: "501", biddingStrategyType: "TARGET_CPA" } }];
    });
  });

  const metaTargets = async () => new Map([["trial-broad", { goal: "event:COMPLETE_REGISTRATION", geo: { regions: [{ key: "33", name: "Eastport", country: "US" }] } }]]);
  const inv = (): Inventory => ({
    meta: { connected: true, ads: [], objects: [adSet("trial-broad", { goal: "event:COMPLETE_REGISTRATION", geo: { regions: [{ key: "33", name: "Eastport", country: "US" }] } })] },
    google: { connected: true, conversions30d: 10, objects: [adSet("501", { platform: "google", level: "campaign", campaign_id: "501" })] },
  });

  it("a sign-up copy may go to the order region nobody reaches; the one a sign-up Google campaign reaches is covered", async () => {
    const { regions } = await loadCopyRegions(T, inv(), NOW, metaTargets);
    expect(regions.map((r) => [r.label, r.covered_goals])).toEqual([
      ["Northfield", []],
      ["Westmoor", ["event:COMPLETE_REGISTRATION"]],
    ]);
    expect(pickCopyRegion("event:COMPLETE_REGISTRATION", regions, new Set())?.meta).toEqual({ type: "region", key: "11", name: "Northfield, United States" });
  });

  it("no located orders, or no business country: no region at all", async () => {
    topOrderLocations.mockResolvedValue([]);
    expect((await loadCopyRegions(T, inv(), NOW, metaTargets)).regions).toEqual([]);
    topOrderLocations.mockResolvedValue([{ label: "Northfield", share: 1 }]);
    businessCountry.mockResolvedValue(null);
    expect((await loadCopyRegions(T, inv(), NOW, metaTargets)).regions).toEqual([]);
  });

  it("a US order region named like a state is looked up as the state (a city of the same name never blocks it)", async () => {
    topOrderLocations.mockResolvedValue([{ label: "Washington", share: 1 }]);
    resolvePlaceDetailed.mockImplementation(async (_t: string, _p: string, _l: string, _c: string, kind?: string) =>
      kind === "State" ? { status: "resolved", place: { id: "region:55", name: "Washington, United States", kind: "State" } } : { status: "ambiguous", candidates: [] },
    );
    const { regions } = await loadCopyRegions(T, inv(), NOW, metaTargets);
    expect(regions.map((r) => r.meta.key)).toEqual(["55"]);
  });

  it("a US order region given by its state code resolves as that state", async () => {
    topOrderLocations.mockResolvedValue([{ label: "tx", share: 1 }]);
    resolvePlaceDetailed.mockImplementation(async (_t: string, _p: string, l: string, _c: string, kind?: string) =>
      kind === "State" && l === "Texas" ? { status: "resolved", place: { id: "region:66", name: "Texas, United States", kind: "State" } } : { status: "not_found" },
    );
    const { regions } = await loadCopyRegions(T, inv(), NOW, metaTargets);
    expect(regions.map((r) => r.meta.key)).toEqual(["66"]);
  });

  it("a region Meta cannot name clearly is skipped", async () => {
    resolvePlaceDetailed.mockResolvedValue({ status: "ambiguous", candidates: [] });
    expect((await loadCopyRegions(T, inv(), NOW, metaTargets)).regions).toEqual([]);
  });

  it("a Meta ad set missing from the copy read covers every goal everywhere", async () => {
    const { regions } = await loadCopyRegions(T, inv(), NOW, async () => new Map());
    expect(regions.every((r) => r.covered_goals.includes(ANY_GOAL))).toBe(true);
  });

  it("an unreadable Meta goal read throws (the controller then copies nothing)", async () => {
    await expect(loadCopyRegions(T, inv(), NOW, async () => { throw new Error("unknown field"); })).rejects.toThrow("unknown field");
  });

  it("an unreadable Google read throws (the controller then copies nothing)", async () => {
    gadsSearch.mockRejectedValue(new Error("google down"));
    await expect(loadCopyRegions(T, inv(), NOW, metaTargets)).rejects.toThrow("google down");
  });
});

describe("fail closed: an unknown never allows a copy", () => {
  const T2 = "22222222-2222-2222-2222-222222222222";
  const region = (covered: string[]): CopyRegion => ({ label: "Northfield", share: 1, place: state("Northfield"), meta: { type: "region", key: "11" }, covered_goals: covered });
  const purchaseBlocked = (covered: string[]) => pickCopyRegion("event:PURCHASE", [region(covered)], new Set()) === null;
  const nf = { regions: [{ key: "11", name: "Northfield", country: "US" }] };

  beforeEach(() => {
    _resetCopyRegionCache();
    topOrderLocations.mockReset().mockResolvedValue([{ label: "Northfield", share: 1 }]);
    businessCountry.mockReset().mockResolvedValue({ code: "US", name: "United States" });
    resolvePlaceDetailed.mockReset().mockResolvedValue({ status: "resolved", place: { id: "region:11", name: "Northfield, United States", kind: "State" } });
    readGooglePlaces.mockReset().mockResolvedValue(new Map());
    gadsSearch.mockReset().mockResolvedValue([]);
  });
  const invWith = (meta: AdObject[], google: AdObject[] = [], over: Partial<Inventory["google"]> = {}): Inventory => ({
    meta: { connected: true, ads: [], objects: meta },
    google: { connected: google.length > 0 || !!over.unread, conversions30d: 1, objects: google, ...over },
  });

  it("source goal unknown: no copy", () => {
    expect(pickCopyRegion(null, [region([])], new Set())).toBeNull();
    expect(pickCopyRegion(undefined, [region([])], new Set())).toBeNull();
  });

  it("Meta goal unknown (conversion with no event, a custom conversion alone, a goal not known here): covers every goal", () => {
    expect(metaGoalKey("OFFSITE_CONVERSIONS", {})).toBeNull();
    expect(metaGoalKey("OFFSITE_CONVERSIONS", { custom_conversion_id: "9" })).toBeNull();
    expect(metaGoalKey("SOME_FUTURE_GOAL", null)).toBeNull();
    const goals = coveredGoals(state("Northfield"), metaCoverage([adSet("x", { goal: null, geo: nf })]), US_STATE_CODES);
    expect(purchaseBlocked(goals)).toBe(true);
  });

  it("Meta places unknown (none read, a country group, a shape not known here, a place with no name): reach everywhere", () => {
    for (const geo of [null, { country_groups: ["worldwide"] }, { brand_new_shape: [{ key: "1" }] }, { regions: [{ key: "99" }] }]) {
      const goals = coveredGoals(state("Northfield"), metaCoverage([adSet("x", { goal: "event:PURCHASE", geo: geo as never })]), US_STATE_CODES);
      expect(purchaseBlocked(goals)).toBe(true);
    }
  });

  it("a city order region whose state is not known is reached by a same-goal ad on any state here", () => {
    const goals = coveredGoals({ kind: "city", country: "US", name: "Brookvale" }, metaCoverage([adSet("x", { goal: "event:PURCHASE", geo: { regions: [{ key: "5", name: "Westmoor", country: "US" }] } })]), US_STATE_CODES);
    expect(purchaseBlocked(goals)).toBe(true);
  });

  it("Google left unread: no Meta read is spent before refusing", async () => {
    let metaReads = 0;
    await expect(
      loadCopyRegions(T2, invWith([], [], { unread: { reason: "x", rate_limited: false, ledger_capacity_usd: 0 } }), NOW, async () => {
        metaReads += 1;
        return new Map();
      }),
    ).rejects.toThrow("not read");
    expect(metaReads).toBe(0);
  });

  it("a configured-on ad set not yet delivering (in review) still covers", () => {
    const goals = coveredGoals(state("Northfield"), metaCoverage([adSet("x", { active: false, parent_active: false, paused_self: false, goal: "event:PURCHASE", geo: nf })]), US_STATE_CODES);
    expect(purchaseBlocked(goals)).toBe(true);
  });

  it("an ad set missing from the goal read covers every goal everywhere", async () => {
    const { regions } = await loadCopyRegions(T2, invWith([adSet("x")]), NOW, async () => new Map());
    expect(purchaseBlocked(regions[0]!.covered_goals)).toBe(true);
  });

  it("the Meta goal read fails: throws (no copy this hour)", async () => {
    await expect(loadCopyRegions(T2, invWith([adSet("x")]), NOW, async () => { throw new Error("graph"); })).rejects.toThrow("graph");
  });

  it("Google connected but not read this hour: throws (no copy this hour)", async () => {
    await expect(loadCopyRegions(T2, invWith([], [], { unread: { reason: "x", rate_limited: false, ledger_capacity_usd: 0 } }), NOW, async () => new Map())).rejects.toThrow("not read");
  });

  it("a Google read fails: throws", async () => {
    gadsSearch.mockRejectedValue(new Error("google down"));
    await expect(loadCopyRegions(T2, invWith([], [adSet("501", { platform: "google", level: "campaign" })]), NOW, async () => new Map())).rejects.toThrow("google down");
  });

  it("Google goal unknown (bidding not known here, conversion bidding with no category, a category not mapped): any goal", () => {
    expect(googleGoalKeys("FUTURE_BIDDING", ["PURCHASE"])).toEqual([ANY_GOAL]);
    expect(googleGoalKeys("TARGET_ROAS", [])).toEqual([ANY_GOAL]);
    expect(googleGoalKeys("TARGET_ROAS", ["STORE_SALE"])).toEqual([ANY_GOAL]);
  });

  it("Google places unknown (no campaign place, an unnamed place, an unreadable criterion) and a campaign the inventory skipped: reach everywhere", async () => {
    const run = async (crit: unknown[], googleObjects: AdObject[]) => {
      gadsSearch.mockImplementation(async (_t: string, q: string) => {
        if (q.includes("FROM campaign_conversion_goal")) return [{ campaign: { id: "501" }, campaignConversionGoal: { category: "PURCHASE", biddable: true } }];
        if (q.includes("FROM campaign_criterion")) return crit;
        return [{ campaign: { id: "501", biddingStrategyType: "TARGET_CPA" } }];
      });
      const { regions } = await loadCopyRegions(T2, invWith([], googleObjects), NOW, async () => new Map());
      return regions[0]!.covered_goals;
    };
    const g501 = [adSet("501", { platform: "google", level: "campaign" })];
    expect(await run([], g501)).toContain("event:PURCHASE");
    expect(await run([{ campaign: { id: "501" }, campaignCriterion: { location: { geoTargetConstant: "geoTargetConstants/123" } } }], g501)).toContain("event:PURCHASE");
    expect(await run([{ campaign: { id: "501" }, campaignCriterion: { location: { geoTargetConstant: "garbage" } } }], g501)).toContain("event:PURCHASE");
    expect(await run([], [adSet("777", { platform: "google", level: "campaign", active: false })])).toContain("event:PURCHASE");
  });

  it("a region lookup fails: throws; an unclear region is skipped (no copy there)", async () => {
    resolvePlaceDetailed.mockRejectedValue(new Error("place search down"));
    await expect(loadCopyRegions(T2, invWith([]), NOW, async () => new Map())).rejects.toThrow("place search down");
    _resetCopyRegionCache();
    resolvePlaceDetailed.mockResolvedValue({ status: "not_found" });
    expect((await loadCopyRegions(T2, invWith([]), NOW, async () => new Map())).regions).toEqual([]);
  });

  it("no located orders or no business country: no region at all", async () => {
    topOrderLocations.mockResolvedValue([]);
    expect((await loadCopyRegions(T2, invWith([]), NOW, async () => new Map())).regions).toEqual([]);
    topOrderLocations.mockResolvedValue([{ label: "Northfield", share: 1 }]);
    businessCountry.mockResolvedValue(null);
    expect((await loadCopyRegions(T2, invWith([]), NOW, async () => new Map())).regions).toEqual([]);
  });
});

describe("recheckRegionCopy: the dispatch-time re-check", () => {
  const T3 = "33333333-3333-3333-3333-333333333333";
  const places = [{ type: "region" as const, key: "11", name: "Northfield, United States" }];
  const TAG = "zv0123456789";
  const source = { id: "120000000100", name: "Weekly clean", campaign_id: "c1", configured_status: "ACTIVE", optimization_goal: "OFFSITE_CONVERSIONS", promoted_object: { custom_event_type: "PURCHASE" }, geo: { regions: [{ key: "22", name: "Westmoor", country: "US" }] } };
  const reads = (over: Partial<RecheckReads> = {}, extraSets: Array<Record<string, unknown>> = []): RecheckReads => ({
    metaAdSets: async () => [source, ...extraSets] as never,
    google: async () => [],
    country: async () => "US",
    shape: async () => "marketplace",
    ...over,
  });
  const check = (r: RecheckReads) => recheckRegionCopy(T3, { level: "adset", source_id: source.id, places, tag: TAG }, r);

  it("must not catch: nothing changed since the plan, so the copy goes ahead", async () => {
    expect(await check(reads())).toEqual({ ok: true });
  });

  it("must not catch: an ad after another goal there, and the copy's own earlier attempt, do not block", async () => {
    const r = await check(
      reads({}, [
        { id: "120000000200", name: "Brand reach", campaign_id: "c2", configured_status: "ACTIVE", optimization_goal: "REACH", geo: { regions: [{ key: "11", name: "Northfield", country: "US" }] } },
        { id: "120000000300", name: `Weekly clean (copy) · ${TAG}`, campaign_id: "c1", configured_status: "ACTIVE", optimization_goal: "OFFSITE_CONVERSIONS", promoted_object: { custom_event_type: "PURCHASE" }, geo: { regions: [{ key: "11", name: "Northfield", country: "US" }] } },
      ]),
    );
    expect(r).toEqual({ ok: true });
  });

  it("must not catch: a campaign copy's retry is not blocked by its own earlier ad sets (the tag sits on the campaign)", async () => {
    const r = await check(
      reads({}, [{ id: "120000000310", name: "Weekly clean", campaign_name: `Weekly clean campaign (copy) · ${TAG}`, campaign_id: "c9", configured_status: "ACTIVE", optimization_goal: "OFFSITE_CONVERSIONS", promoted_object: { custom_event_type: "PURCHASE" }, geo: { regions: [{ key: "11", name: "Northfield", country: "US" }] } }]),
    );
    expect(r).toEqual({ ok: true });
  });

  it("must not catch: a same-goal ad set with no ad that can show does not block (as the planner judges it)", async () => {
    const r = await check(
      reads({}, [{ id: "120000000420", name: "Shell", campaign_id: "c4", configured_status: "ACTIVE", has_live_ads: false, optimization_goal: "OFFSITE_CONVERSIONS", promoted_object: { custom_event_type: "PURCHASE" }, geo: { regions: [{ key: "11", name: "Northfield", country: "US" }] } }]),
    );
    expect(r).toEqual({ ok: true });
  });

  it("fail closed: the Meta reader treats an ad with no status returned as maybe live (the ad set still covers)", async () => {
    fbGetAllPages.mockResolvedValue([
      { ...source, targeting: { geo_locations: source.geo }, ads: { data: [{ effective_status: "ACTIVE" }] } },
      { id: "120000000430", name: "Northfield push", campaign_id: "c3", configured_status: "ACTIVE", optimization_goal: "OFFSITE_CONVERSIONS", promoted_object: { custom_event_type: "PURCHASE" }, targeting: { geo_locations: { regions: [{ key: "11", name: "Northfield", country: "US" }] } }, ads: { data: [{ effective_status: "PAUSED" }, {}] } },
    ]);
    const r = await recheckRegionCopy(T3, { level: "adset", source_id: source.id, places, tag: TAG }, { ...defaultRecheckReads, google: async () => [], country: async () => "US", shape: async () => "marketplace" });
    expect(r.ok).toBe(false);
    fbGetAllPages.mockResolvedValue([
      { ...source, targeting: { geo_locations: source.geo }, ads: { data: [{ effective_status: "ACTIVE" }] } },
      { id: "120000000430", name: "Northfield push", campaign_id: "c3", configured_status: "ACTIVE", optimization_goal: "OFFSITE_CONVERSIONS", promoted_object: { custom_event_type: "PURCHASE" }, targeting: { geo_locations: { regions: [{ key: "11", name: "Northfield", country: "US" }] } }, ads: { data: [{ effective_status: "PAUSED" }] } },
    ]);
    expect(await recheckRegionCopy(T3, { level: "adset", source_id: source.id, places, tag: TAG }, { ...defaultRecheckReads, google: async () => [], country: async () => "US", shape: async () => "marketplace" })).toEqual({ ok: true });
  });

  it("fail closed: a same-goal ad set whose status was not returned counts as on", async () => {
    const r = await check(
      reads({}, [{ id: "120000000410", name: "Northfield push", campaign_id: "c3", configured_status: null, optimization_goal: "OFFSITE_CONVERSIONS", promoted_object: { custom_event_type: "PURCHASE" }, geo: { regions: [{ key: "11", name: "Northfield", country: "US" }] } }]),
    );
    expect(r.ok).toBe(false);
  });

  it("must catch: a same-goal Meta ad set went live in the region since the plan", async () => {
    const r = await check(
      reads({}, [{ id: "120000000400", name: "Northfield push", campaign_id: "c3", configured_status: "ACTIVE", optimization_goal: "VALUE", promoted_object: { custom_event_type: "PURCHASE" }, geo: { regions: [{ key: "11", name: "Northfield", country: "US" }] } }]),
    );
    expect(r).toMatchObject({ ok: false, why: expect.stringMatching(/same result/) });
  });

  it("must catch: a same-goal Google campaign now reaches the region", async () => {
    const r = await check(reads({ google: async () => [{ goals: ["event:PURCHASE"], places: [{ kind: "state", country: "US", name: "Northfield" }] }] }));
    expect(r.ok).toBe(false);
  });

  it("not a marketplace (or unknown): the region copy is refused at dispatch too", async () => {
    expect((await check(reads({ shape: async () => "saas" }))).ok).toBe(false);
    expect((await check(reads({ shape: async () => null }))).ok).toBe(false);
  });

  it("fail closed: any read error, an unknown source goal or an unknown country refuses", async () => {
    expect((await check(reads({ metaAdSets: async () => { throw new Error("graph down"); } }))).ok).toBe(false);
    expect((await check(reads({ google: async () => { throw new Error("google down"); } }))).ok).toBe(false);
    expect((await check(reads({ country: async () => null }))).ok).toBe(false);
    expect((await check({ ...reads(), metaAdSets: async () => [{ ...source, promoted_object: {} }] as never })).ok).toBe(false);
    expect((await check({ ...reads(), metaAdSets: async () => [] })).ok).toBe(false);
  });
});

describe("ambiguous or differently written place names count as covered", () => {
  const cov = (p: NamedPlace) => [p];
  it("Washington the state vs Washington D.C. (a Meta city) vs a Google city of the same name", () => {
    const waState: NamedPlace = { kind: "state", country: "US", name: "Washington", key: "3890" };
    expect(reaches(cov({ kind: "city", country: "US", name: "Washington", state: "District of Columbia", key: "2421836" }), waState, US_STATE_CODES)).toBe(true);
    expect(reaches(cov({ kind: "state", country: "US", name: "Washington" }), { kind: "city", country: "US", name: "Washington", state: "District of Columbia", key: "2421836" }, US_STATE_CODES)).toBe(true);
  });
  it("New York the city vs New York the state, either way round", () => {
    expect(reaches(cov({ kind: "state", country: "US", name: "New York" }), { kind: "city", country: "US", name: "New York", key: "2490299" }, US_STATE_CODES)).toBe(true);
    expect(reaches(cov({ kind: "city", country: "US", name: "New York", state: "NY" }), { kind: "state", country: "US", name: "New York", key: "3875" }, US_STATE_CODES)).toBe(true);
  });
  it("a state code against its full name, and case or spacing differences", () => {
    expect(reaches(cov({ kind: "state", country: "US", name: "WA" }), { kind: "state", country: "US", name: "Washington" }, US_STATE_CODES)).toBe(true);
    expect(reaches(cov({ kind: "state", country: "US", name: "  new YORK " }), { kind: "state", country: "US", name: "New York" }, US_STATE_CODES)).toBe(true);
  });
  it("location IDs decide when both sides have one: the same ID under another name is covered, another ID is not", () => {
    expect(reaches(cov({ kind: "state", country: "US", name: "Northfield (old name)", key: "11" }), { kind: "state", country: "US", name: "Northfield", key: "11" }, US_STATE_CODES)).toBe(true);
    expect(reaches(cov({ kind: "state", country: "US", name: "Northfield", key: "12" }), { kind: "state", country: "US", name: "Northfield", key: "11" }, US_STATE_CODES)).toBe(false);
  });
  it("any non-ASCII name counts as covered (no copy), whatever it says", () => {
    expect(reaches(cov({ kind: "city", country: "JP", name: "札幌市" }), { kind: "state", country: "JP", name: "Osaka" }, US_STATE_CODES)).toBe(true);
    expect(reaches(cov({ kind: "city", country: "US", name: "Westmoor" }), { kind: "city", country: "US", name: "São Paulo" }, US_STATE_CODES)).toBe(true);
  });

  it("must not catch: a different place by name and key stays open", () => {
    expect(reaches(cov({ kind: "state", country: "US", name: "Westmoor", key: "22" }), { kind: "state", country: "US", name: "Northfield", key: "11" }, US_STATE_CODES)).toBe(false);
  });
});

describe("resolveBusinessShape", () => {
  it("the declared company shape wins; unset falls back to a confirmed marketplace mapping; else unknown", async () => {
    const { resolveBusinessShape } = await import("../business-shape");
    expect(await resolveBusinessShape("t", { companyShape: async () => ({ shape: "marketplace", source: "founder" }), marketplaceConfirmed: async () => false })).toBe("marketplace");
    expect(await resolveBusinessShape("t", { companyShape: async () => ({ shape: "saas", source: "founder" }), marketplaceConfirmed: async () => true })).toBe("saas");
    expect(await resolveBusinessShape("t", { companyShape: async () => ({ shape: null, source: null }), marketplaceConfirmed: async () => true })).toBe("marketplace");
    expect(await resolveBusinessShape("t", { companyShape: async () => ({ shape: null, source: null }), marketplaceConfirmed: async () => false })).toBeNull();
    expect(await resolveBusinessShape("t", { companyShape: async () => ({ shape: "not-a-shape", source: "founder" }), marketplaceConfirmed: async () => false })).toBeNull();
  });
  it("a read error is unknown, never a guess", async () => {
    const { resolveBusinessShape } = await import("../business-shape");
    expect(await resolveBusinessShape("t", { companyShape: async () => { throw new Error("db down"); }, marketplaceConfirmed: async () => true })).toBeNull();
  });
});
