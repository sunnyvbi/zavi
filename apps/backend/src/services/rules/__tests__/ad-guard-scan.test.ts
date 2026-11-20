import { describe, it, expect, vi, beforeEach } from "vitest";

const gads = vi.hoisted(() => ({ search: vi.fn(), metaPages: vi.fn(), metaOn: false }));
vi.mock("@/services/tools/google-ads/_client", () => ({ gadsSearch: gads.search }));
const qdb = vi.hoisted(() => ({ rows: [] as Array<{ topic_key: string; status: string; asked_at: string; answered_at: string | null }>, chunks: [] as number[], filters: [] as string[] }));
vi.mock("@/services/tenant-client", async (orig) => ({
  ...(await orig<typeof import("@/services/tenant-client")>()),
  tenantClient: () => {
    let keys: string[] = [];
    const q = {
      select: () => q,
      eq: () => q,
      or: (f: string) => {
        qdb.filters.push(f);
        return q;
      },
      in: (col: string, v: string[]) => {
        if (col === "topic_key") {
          keys = v;
          qdb.chunks.push(v.length);
        }
        return q;
      },
      then: (res: (x: unknown) => unknown) => res({ data: qdb.rows.filter((r) => keys.includes(r.topic_key)), error: null }),
    };
    return { from: () => q };
  },
}));
vi.mock("@/services/tools/meta-ads/_client", () => ({
  metaAdsCreds: async () => {
    if (!gads.metaOn) throw Object.assign(new Error("meta not connected"), { code: "not_connected" });
    return { ad_account_id: "act_1" };
  },
  fbGetAllPages: (...a: unknown[]) => gads.metaPages(...a),
}));

import { canonFromGoogle, canonFromMetaSaved, inside, judgePlace, phraseIn, type Canon } from "../ad-guard-match";
import { AD_GUARD_QUESTIONS_MAX, defaultScanDeps, metaGeoCanons, scanTenantAdGuard, type ScanDeps, type LiveTarget, type LiveAd } from "../ad-guard-scan";
import { EMPTY_AD_GUARD, type AdGuard } from "../ad-guard";

const oregon = canonFromGoogle("Oregon,United States", "State")!;
const portlandOR = canonFromGoogle("Portland,Oregon,United States", "City")!;
const portlandME = canonFromGoogle("Portland,Maine,United States", "City")!;
const countryName = (c: string) => ({ US: "United States", CA: "Canada" })[c] ?? c;

describe("place matching", () => {
  it("a city is inside its state across platforms (Meta 'OR' style names too)", () => {
    expect(inside(portlandOR, oregon)).toBe(true);
    expect(inside(portlandME, oregon)).toBe(false);
    const metaCity = canonFromMetaSaved("Portland, OR", "City")!;
    expect(inside(metaCity, oregon)).toBe(true);
  });
  it("must catch: a target outside the allowed area; a target covering a blocked city", () => {
    expect(judgePlace(portlandME, [oregon], [])).toMatchObject({ ok: false, why: "outside" });
    expect(judgePlace(oregon, [], [portlandOR])).toMatchObject({ ok: false, why: "blocked" });
  });
  it("must not catch: inside the allowed area; nothing blocked overlaps", () => {
    expect(judgePlace(portlandOR, [oregon], [portlandME])).toEqual({ ok: true });
  });
  it("a name a side does not give is 'could not check', never fine", () => {
    const noCountryCity: Canon = { level: "city", city: "portland" };
    expect(judgePlace(noCountryCity, [oregon], [])).toEqual({ ok: null });
  });
  it("Meta geo: pins and postcodes cannot be checked; regions and cities read with their country", () => {
    expect(metaGeoCanons({ custom_locations: [{ latitude: 1 }] }, countryName)).toBeNull();
    expect(metaGeoCanons({ regions: [{ name: "Oregon", country: "US" }] }, countryName)).toEqual([{ level: "region", region: "oregon", country: "united states" }]);
  });
  it("Meta geo: a city with a radius reaches past the city, so it cannot be checked", () => {
    expect(metaGeoCanons({ cities: [{ name: "Portland", region: "Oregon", country: "US", radius: 25 }] }, countryName)).toBeNull();
    expect(metaGeoCanons({ cities: [{ name: "Portland", region: "Oregon", country: "US" }] }, countryName)).toHaveLength(1);
  });
  it("accents fold: a bakery's saved 'Sao Paulo' matches a target named 'São Paulo'", () => {
    const saved = canonFromGoogle("Sao Paulo,State of Sao Paulo,Brazil", "City")!;
    const live = canonFromGoogle("São Paulo,State of São Paulo,Brazil", "City")!;
    expect(judgePlace(live, [saved], [])).toEqual({ ok: true });
  });
  it("an allowed place the check could not read: never 'outside'; an unread blocked place: never 'fine'", () => {
    expect(judgePlace(portlandME, [oregon], [], { allowed: true })).toEqual({ ok: null });
    expect(judgePlace(portlandOR, [oregon], [], { blocked: true })).toEqual({ ok: null });
    expect(judgePlace(portlandME, [oregon], [], { blocked: true })).toMatchObject({ ok: false, why: "outside" });
    expect(judgePlace(portlandME, [], [oregon], { allowed: true })).toEqual({ ok: null });
  });
  it("phrases: case-insensitive whole words (a SaaS banning 'pro' does not flag 'product')", () => {
    expect(phraseIn("Try our PRO plan today", "pro")).toBe(true);
    expect(phraseIn("A product for teams", "pro")).toBe(false);
    expect(phraseIn("Cheapest   in town!", "cheapest in town")).toBe(true);
  });
});

function deps(guard: AdGuard, targets: LiveTarget[], ads: LiveAd[]) {
  const asked: Array<{ topic: string; ask: string }> = [];
  const reads = { targets: 0, ads: 0 };
  const d: ScanDeps = {
    readGuard: async () => guard,
    savedCanons: async (_t, places) => places.map((p) => (p.platform === "google" ? canonFromGoogle(p.name, p.kind) : canonFromMetaSaved(p.name, p.kind))),
    readTargets: async () => {
      reads.targets += 1;
      return targets;
    },
    readAds: async () => {
      reads.ads += 1;
      return ads;
    },
    didYouMean: async () => "Portland, OR",
    ask: vi.fn(async (_t: string, topic: string, ask: string) => {
      asked.push({ topic, ask });
      return true;
    }),
  };
  return { d, asked, reads };
}

const florist: AdGuard = {
  allowed_places: [{ id: "21137", name: "Oregon,United States", kind: "State", platform: "google" }],
  blocked_places: [],
  banned_phrases: ["cheapest in town"],
};

describe("scanTenantAdGuard", () => {
  it("must catch (florist): an ad set outside the service area and an ad with a banned phrase each get one question", async () => {
    const { d, asked } = deps(
      florist,
      [{ platform: "meta", object_id: "s1", name: "Spring bouquets", places: [portlandME] }],
      [{ platform: "google", ad_id: "a9", name: "Roses ad", text: "Cheapest in town, same-day delivery" }],
    );
    const r = await scanTenantAdGuard("t1", d);
    expect(r).toMatchObject({ outcome: "checked", violations: 2 });
    expect(asked.map((a) => a.topic)).toEqual(["ad_rule:meta:s1:outside", "ad_rule:google:a9:phrase"]);
    expect(asked[0]!.ask).toContain("Did you mean Portland, OR?");
  });

  it("must not catch: targets inside the area and clean words: no question", async () => {
    const { d, asked } = deps(florist, [{ platform: "google", object_id: "c1", name: "Search", places: [portlandOR] }], [{ platform: "meta", ad_id: "m1", name: "Tulips", text: "Fresh tulips delivered" }]);
    const r = await scanTenantAdGuard("t1", d);
    expect(r).toMatchObject({ outcome: "checked", violations: 0, asked: 0 });
    expect(asked).toEqual([]);
  });

  it("targets it cannot check go into ONE combined question per scan, never one per object", async () => {
    const { d, asked } = deps(
      { ...florist, banned_phrases: [] },
      [
        { platform: "meta", object_id: "p1", name: "Pin radius", places: null },
        { platform: "meta", object_id: "p2", name: "Postcodes", places: null },
      ],
      [],
    );
    await scanTenantAdGuard("t1", d);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.topic).toBe("ad_rule:unchecked");
    expect(asked[0]!.ask).toContain("2 things");
  });

  it("no saved rules: no platform read at all", async () => {
    const { d, reads, asked } = deps(EMPTY_AD_GUARD, [], []);
    expect(await scanTenantAdGuard("t1", d)).toMatchObject({ outcome: "no_rules" });
    expect(reads).toEqual({ targets: 0, ads: 0 });
    expect(asked).toEqual([]);
  });

  it("only phrases saved: places are not read", async () => {
    const { d, reads } = deps({ ...EMPTY_AD_GUARD, banned_phrases: ["guaranteed"] }, [], []);
    await scanTenantAdGuard("t1", d);
    expect(reads).toEqual({ targets: 0, ads: 1 });
  });

  it("a failing read is that tenant's error, never a throw", async () => {
    const { d } = deps(florist, [], []);
    d.readTargets = async () => Promise.reject(new Error("Graph 500"));
    expect(await scanTenantAdGuard("t1", d)).toMatchObject({ outcome: "error" });
  });

  it("no did-you-mean helper: an outside city is still asked, never a throw", async () => {
    const { d, asked } = deps({ ...florist, banned_phrases: [] }, [{ platform: "meta", object_id: "s2", name: "Lilies", places: [portlandME] }], []);
    delete d.didYouMean;
    expect(await scanTenantAdGuard("t1", d)).toMatchObject({ outcome: "checked", asked: 1 });
    expect(asked[0]!.topic).toBe("ad_rule:meta:s2:outside");
  });

  it("a saved allowed place it cannot read: a target elsewhere is unchecked, not 'outside'", async () => {
    const { d, asked } = deps({ ...florist, banned_phrases: [] }, [{ platform: "meta", object_id: "s3", name: "Peonies", places: [portlandME] }], []);
    d.savedCanons = async (_t, places) => places.map((p) => (p.name.startsWith("Oregon") ? oregon : null));
    const g: AdGuard = { ...florist, banned_phrases: [], allowed_places: [...florist.allowed_places, { id: "x", name: "Somewhere odd", kind: "Region", platform: "meta" }] };
    d.readGuard = async () => g;
    await scanTenantAdGuard("t1", d);
    expect(asked.map((a) => a.topic)).toEqual(["ad_rule:unchecked"]);
  });

  it("ads whose words cannot be read are counted once in the combined question", async () => {
    const { d, asked } = deps({ ...EMPTY_AD_GUARD, banned_phrases: ["guaranteed"] }, [], [
      { platform: "google", ad_id: "v1", name: "Video", text: null },
      { platform: "google", ad_id: "i1", name: "Image", text: null },
    ]);
    await scanTenantAdGuard("t1", d);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.topic).toBe("ad_rule:unchecked");
    expect(asked[0]!.ask).toContain("2 ads whose words");
  });

  it("already-asked topics never take a slot: later findings surface on later days", async () => {
    const ads: LiveAd[] = Array.from({ length: 60 }, (_, i) => ({ platform: "meta", ad_id: `a${i}`, name: `Ad ${i}`, text: "guaranteed results" }));
    const { d } = deps({ ...EMPTY_AD_GUARD, banned_phrases: ["guaranteed"] }, [], ads);
    const open = new Set(Array.from({ length: 40 }, (_, i) => `ad_rule:meta:a${i}:phrase`));
    d.alreadyAsked = async (_t, topics) => new Set(topics.filter((t) => open.has(t)));
    const filed: string[] = [];
    d.ask = async (_t, topic) => {
      filed.push(topic);
      return true;
    };
    expect(await scanTenantAdGuard("t1", d)).toMatchObject({ asked: AD_GUARD_QUESTIONS_MAX });
    expect(filed[0]).toBe("ad_rule:meta:a40:phrase");
    expect(filed).toHaveLength(AD_GUARD_QUESTIONS_MAX);
  });

  it("many findings still leave a slot for the combined 'could not check' question", async () => {
    const ads: LiveAd[] = [
      ...Array.from({ length: 20 }, (_, i): LiveAd => ({ platform: "meta", ad_id: `a${i}`, name: `Ad ${i}`, text: "guaranteed" })),
      { platform: "meta", ad_id: "p1", name: "Photo only", text: null },
    ];
    const { d, asked } = deps({ ...EMPTY_AD_GUARD, banned_phrases: ["guaranteed"] }, [], ads);
    expect(await scanTenantAdGuard("t1", d)).toMatchObject({ asked: AD_GUARD_QUESTIONS_MAX });
    expect(asked).toHaveLength(AD_GUARD_QUESTIONS_MAX);
    expect(asked.at(-1)!.topic).toBe("ad_rule:unchecked");
  });

  it("an ad read only in part: a hit is asked, a miss is 'could not check', never clean", async () => {
    const { d, asked } = deps({ ...EMPTY_AD_GUARD, banned_phrases: ["guaranteed"] }, [], [
      { platform: "google", ad_id: "d1", name: "Display hit", text: "Guaranteed blooms", partial: true },
      { platform: "google", ad_id: "d2", name: "Display miss", text: "Fresh blooms", partial: true },
    ]);
    await scanTenantAdGuard("t1", d);
    expect(asked.map((a) => a.topic)).toEqual(["ad_rule:google:d1:phrase", "ad_rule:unchecked"]);
    expect(asked[1]!.ask).toContain("1 ad whose words");
  });

  it("asks that keep failing stop after a bounded number of attempts", async () => {
    const ads: LiveAd[] = Array.from({ length: 200 }, (_, i) => ({ platform: "meta", ad_id: `a${i}`, name: `Ad ${i}`, text: "guaranteed" }));
    const { d } = deps({ ...EMPTY_AD_GUARD, banned_phrases: ["guaranteed"] }, [], ads);
    const ask = vi.fn(async () => false);
    d.ask = ask;
    await scanTenantAdGuard("t1", d);
    expect(ask).toHaveBeenCalledTimes(AD_GUARD_QUESTIONS_MAX * 3);
  });
});

describe("Google readers", () => {
  beforeEach(() => {
    gads.search.mockReset();
    gads.metaPages.mockReset();
    gads.metaOn = false;
  });
  function google(crits: unknown[], ads: unknown[] = []) {
    gads.search.mockImplementation(async (_t: string, q: string) => {
      if (q.includes("FROM campaign_criterion")) return crits;
      if (q.includes("FROM campaign ")) return [{ campaign: { id: 1, name: "Search A", advertisingChannelType: "SEARCH" } }];
      if (q.includes("FROM geo_target_constant")) return [{ geoTargetConstant: { id: 21137, canonicalName: "Oregon,United States", targetType: "State" } }];
      if (q.includes("FROM ad_group_ad")) return ads;
      return [];
    });
  }
  it("a radius or an excluded place makes a campaign uncheckable; a plain state is read", async () => {
    google([{ campaign: { id: 1 }, campaignCriterion: { type: "LOCATION", location: { geoTargetConstant: "geoTargetConstants/21137" } } }]);
    expect((await defaultScanDeps().readTargets("t1"))[0]!.places).toEqual([oregon]);
    google([
      { campaign: { id: 1 }, campaignCriterion: { type: "LOCATION", location: { geoTargetConstant: "geoTargetConstants/21137" } } },
      { campaign: { id: 1 }, campaignCriterion: { type: "PROXIMITY" } },
    ]);
    expect((await defaultScanDeps().readTargets("t1"))[0]!.places).toBeNull();
    google([
      { campaign: { id: 1 }, campaignCriterion: { type: "LOCATION", location: { geoTargetConstant: "geoTargetConstants/21137" } } },
      { campaign: { id: 1 }, campaignCriterion: { type: "LOCATION", negative: true, location: { geoTargetConstant: "geoTargetConstants/21137" } } },
    ]);
    expect((await defaultScanDeps().readTargets("t1"))[0]!.places).toBeNull();
  });
  it("ads of a kind with no text reader come back unread, not skipped", async () => {
    google([], [
      { adGroupAd: { ad: { id: 5, type: "RESPONSIVE_SEARCH_AD", responsiveSearchAd: { headlines: [{ text: "Guaranteed results" }] } } } },
      { adGroupAd: { ad: { id: 6, type: "VIDEO_RESPONSIVE_AD" } } },
      { adGroupAd: { ad: { id: 7, type: "RESPONSIVE_DISPLAY_AD", responsiveDisplayAd: { longHeadline: { text: "Same-day" } } } } },
    ]);
    const ads = await defaultScanDeps().readAds("t1");
    expect(ads.map((a) => [a.ad_id, a.text, a.partial ?? false])).toEqual([
      ["5", "Guaranteed results", false],
      ["6", null, false],
      ["7", "Same-day", true],
    ]);
  });
  it("a live Meta ad with no readable words is counted as unread, not dropped", async () => {
    gads.search.mockRejectedValue(Object.assign(new Error("google not connected"), { code: "google_ads_not_connected" }));
    gads.metaOn = true;
    gads.metaPages.mockImplementation(async () => [
      { id: "m1", name: "Photo only", effective_status: "ACTIVE", creative: {} },
      { id: "m2", name: "Words", effective_status: "ACTIVE", creative: { body: "Guaranteed" } },
    ]);
    const ads = await defaultScanDeps().readAds("t1");
    expect(ads.map((a) => [a.ad_id, a.text])).toEqual([
      ["m1", null],
      ["m2", "Guaranteed"],
    ]);
  });
  it("a failed lookup of saved Google places fails the tenant, never reads as 'nothing saved'", async () => {
    gads.search.mockRejectedValue(new Error("Google 500"));
    await expect(defaultScanDeps().savedCanons("t1", [{ id: "21137", name: "Oregon", kind: "State", platform: "google" }])).rejects.toThrow("Google 500");
  });
  it("Google not connected: its saved places are unread, Meta's still read", async () => {
    gads.search.mockRejectedValue(Object.assign(new Error("not connected"), { code: "google_ads_not_connected" }));
    const out = await defaultScanDeps().savedCanons("t1", [
      { id: "21137", name: "Oregon", kind: "State", platform: "google" },
      { id: "m9", name: "Oregon, United States", kind: "State", platform: "meta" },
    ]);
    expect(out[0]).toBeNull();
    expect(out[1]).not.toBeNull();
  });
});

describe("already-asked lookup", () => {
  it("finds every open ad topic by key, past any page size; an answer older than the re-ask window is asked again", async () => {
    const topics = Array.from({ length: 150 }, (_, i) => `ad_rule:meta:a${i}:phrase`);
    const { normalizeTopic } = await import("@/services/growth/cgo-questions");
    const now = new Date().toISOString();
    qdb.rows = [
      ...topics.slice(0, 120).map((t) => ({ topic_key: normalizeTopic(t), status: "open", asked_at: now, answered_at: null })),
      { topic_key: normalizeTopic(topics[140]!), status: "answered", asked_at: "2020-01-01T00:00:00Z", answered_at: "2020-01-02T00:00:00Z" },
    ];
    qdb.chunks = [];
    const done = await defaultScanDeps().alreadyAsked!("t1", topics);
    expect(done.size).toBe(120);
    expect(done.has(topics[119]!)).toBe(true);
    expect(done.has(topics[140]!)).toBe(false);
    expect(qdb.chunks).toEqual([100, 50]);
    expect(qdb.filters[0]).toMatch(/^status\.in\.\(open,queued\),and\(status\.eq\.answered,answered_at\.gte\./);
  });
});
