import { describe, expect, it } from "vitest";
import { NO_FILTERS, activeCount, filtersFromParams, filtersToParams, matchesLocally, searchPath } from "./FindFilters";

const creator = (over: Record<string, unknown> = {}) =>
  ({
    human_member_id: "m1",
    slug: "maya",
    display_name: "Maya Films",
    lanes: ["ugc_video"],
    niches: ["Beauty"],
    platforms: ["tiktok"],
    location: { city: "Austin", country_code: "US" },
    bookable: true,
    not_bookable_message: null,
    self_reported_audience: [],
    handles: [{ platform: "tiktok", handle: "mayafilms", url: null, followers: 12_000, label: "" }],
    packages: [{ title: "Three ad videos" }],
    from_price_cents: 15_000,
    from_price_business_total_cents: 16_500,
    joined_at: null,
    ...over,
  }) as never;

describe("searchPath", () => {
  it("sends only the filters the server applies, with the neutral order", () => {
    expect(searchPath(NO_FILTERS)).toBe("/api/humans/creators/search?order=newest&limit=100");
    const url = new URL(
      `http://x${searchPath({
        ...NO_FILTERS,
        platform: "tiktok",
        niches: ["Beauty", "Tech"],
        lane: "ugc_video",
        maxPriceCents: 25_000,
        maxDeliveryDays: 7,
        country: "US",
        order: "a_to_z",
        keyword: "maya",
        minFollowers: 10_000,
      })}`,
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      order: "a_to_z",
      limit: "100",
      platform: "tiktok",
      niches: "Beauty,Tech",
      lane: "ugc_video",
      max_price_cents: "25000",
      max_delivery_days: "7",
      country_code: "US",
    });
  });
});

describe("matchesLocally", () => {
  it("needs every keyword word somewhere the card shows", () => {
    expect(matchesLocally(creator(), { ...NO_FILTERS, keyword: "maya beauty" })).toBe(true);
    expect(matchesLocally(creator(), { ...NO_FILTERS, keyword: "three videos" })).toBe(true);
    expect(matchesLocally(creator(), { ...NO_FILTERS, keyword: "maya fitness" })).toBe(false);
    expect(matchesLocally(creator(), { ...NO_FILTERS, keyword: "skincare" }, "I film skincare routines")).toBe(true);
  });

  it("reads the follower floor from the largest self-reported account", () => {
    expect(matchesLocally(creator(), { ...NO_FILTERS, minFollowers: 10_000 })).toBe(true);
    expect(matchesLocally(creator(), { ...NO_FILTERS, minFollowers: 100_000 })).toBe(false);
    expect(matchesLocally(creator({ handles: [] }), { ...NO_FILTERS, minFollowers: 1_000 })).toBe(false);
  });
});

describe("activeCount", () => {
  it("counts each filter and each niche, not the order", () => {
    expect(activeCount(NO_FILTERS)).toBe(0);
    expect(activeCount({ ...NO_FILTERS, order: "a_to_z" })).toBe(0);
    expect(activeCount({ ...NO_FILTERS, niches: ["Beauty", "Tech"], platform: "x", keyword: " " })).toBe(3);
  });
});

describe("filters in the URL", () => {
  it("survive a round trip through the URL keys", () => {
    const f = {
      ...NO_FILTERS,
      platform: "tiktok",
      keyword: "maya films",
      niches: ["Beauty", "Tech"],
      lane: "ugc_video",
      maxPriceCents: 25_000,
      maxDeliveryDays: 7,
      minFollowers: 10_000,
      country: "US",
      order: "a_to_z" as const,
    };
    expect(filtersFromParams(filtersToParams(f))).toEqual(f);
  });

  it("leaves the defaults out, so a plain URL stays plain", () => {
    expect(filtersToParams(NO_FILTERS)).toEqual({});
  });

  it("drops a malformed value instead of guessing", () => {
    const f = filtersFromParams({ max_price: "-5", max_days: "abc", min_followers: "1e9", country: "USA", sort: "best_match" });
    expect(f.maxPriceCents).toBeNull();
    expect(f.maxDeliveryDays).toBeNull();
    expect(f.minFollowers).toBeNull();
    expect(f.country).toBeNull();
    expect(f.order).toBe("newest");
  });
});
