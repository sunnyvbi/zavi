
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("../../_client", async (orig) => ({ ...(await orig<typeof import("../../_client")>()), fbGet: h.get, fbPost: h.post }));

import {
  metaGeoFingerprint,
  metaReplaceAdSetGeo,
  replaceAdSetGeoBodySchema,
  shapeGeoLocations,
  unsupportedGeoKeys,
  verifyMetaPlaces,
} from "../replace_ad_set_geo";

const T = "11111111-1111-4111-8111-111111111111";
const targeting = {
  age_min: 25,
  flexible_spec: [{ interests: [{ id: "6003", name: "Coffee" }] }],
  targeting_automation: { advantage_audience: 0 },
  excluded_geo_locations: { countries: ["CA"] },
  geo_locations: { countries: ["US"], location_types: ["home", "recent"] },
};

const body = (over: Record<string, unknown> = {}) =>
  replaceAdSetGeoBodySchema.parse({
    ad_set_id: "777",
    places: [
      { type: "city", key: "2420379", name: "San Francisco, California" },
      { type: "city", key: "2421836", name: "Oakland, California" },
    ],
    before_names: ["United States"],
    expected_fingerprint: metaGeoFingerprint(targeting.geo_locations),
    rationale: "founder pick",
    origin: "user_initiated_ledger",
    ...over,
  });

beforeEach(() => {
  h.get.mockReset();
  h.post.mockReset();
  h.post.mockResolvedValue({ success: true });
});

describe("the write", () => {
  it("swaps geo_locations only, keeps location_types and every other targeting field, reads back", async () => {
    h.get
      .mockResolvedValueOnce({ name: "Zavi · Coffee", targeting })
      .mockResolvedValueOnce({ targeting: { ...targeting, geo_locations: { cities: [{ key: "2420379" }, { key: "2421836" }] } } });
    const r = await metaReplaceAdSetGeo(T, body());
    const sent = JSON.parse(h.post.mock.calls[0][2].targeting);
    expect(h.post.mock.calls[0][1]).toBe("777");
    expect(sent.geo_locations).toEqual({ cities: [{ key: "2420379" }, { key: "2421836" }], location_types: ["home", "recent"] });
    for (const k of ["age_min", "flexible_spec", "targeting_automation", "excluded_geo_locations"] as const) expect(sent[k]).toEqual(targeting[k]);
    expect(r.verified).toBe(true);
  });

  it("a stale fingerprint changes nothing", async () => {
    h.get.mockResolvedValueOnce({ targeting: { ...targeting, geo_locations: { countries: ["GB"] } } });
    await expect(metaReplaceAdSetGeo(T, body())).rejects.toMatchObject({ code: "meta_ads_geo_stale" });
    expect(h.post).not.toHaveBeenCalled();
  });

  it("an ad set with postcodes or pins is unsupported here: nothing is dropped", async () => {
    const geo = { countries: ["US"], zips: [{ key: "US:94105" }] };
    h.get.mockResolvedValueOnce({ targeting: { ...targeting, geo_locations: geo } });
    await expect(metaReplaceAdSetGeo(T, body({ expected_fingerprint: metaGeoFingerprint(geo) }))).rejects.toMatchObject({ code: "meta_ads_geo_unsupported" });
    expect(h.post).not.toHaveBeenCalled();
    expect(unsupportedGeoKeys(geo)).toEqual(["zips"]);
  });
});

describe("the pure halves", () => {
  it("shapes countries, regions and cities, de-duplicated", () => {
    expect(
      shapeGeoLocations(
        [
          { type: "country", key: "us" },
          { type: "region", key: "3847" },
          { type: "city", key: "1" },
          { type: "city", key: "1" },
        ],
        null,
      ),
    ).toEqual({ countries: ["US"], regions: [{ key: "3847" }], cities: [{ key: "1" }] });
  });

  it("the fingerprint ignores display names and order", () => {
    expect(metaGeoFingerprint({ cities: [{ key: "1", name: "A" }, { key: "2" }] })).toBe(metaGeoFingerprint({ cities: [{ key: "2", name: "B" }, { key: "1" }] }));
    expect(metaGeoFingerprint({ countries: ["US"] })).not.toBe(metaGeoFingerprint({ countries: ["CA"] }));
  });

  it("the body caps places at 50 and demands the founder origin", () => {
    expect(() => body({ places: Array.from({ length: 51 }, (_, i) => ({ type: "city", key: String(i + 1) })) })).toThrow();
    expect(() => body({ origin: "user_initiated_chat" })).toThrow();
  });
});

describe("checking picks with Meta", () => {
  it("names each key from Meta, and refuses a key Meta does not know", async () => {
    h.get.mockResolvedValueOnce({ data: { cities: { "2420379": { key: "2420379", name: "San Francisco", region: "California" } }, countries: { US: { key: "US", name: "United States" } } } });
    expect(await verifyMetaPlaces(T, [{ type: "city", key: "2420379" }, { type: "country", key: "US" }])).toEqual([
      { type: "city", key: "2420379", name: "San Francisco, California" },
      { type: "country", key: "US", name: "United States" },
    ]);
    h.get.mockResolvedValueOnce({ data: { cities: {} } });
    await expect(verifyMetaPlaces(T, [{ type: "city", key: "999" }])).rejects.toMatchObject({ code: "ad_locations_bad_place" });
  });
});
