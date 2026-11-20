
import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({ facts: {} as Record<string, { value: string }> }));
vi.mock("@/services/company/facts", () => ({ getCompanyFacts: async () => ({ facts: h.facts }) }));

import { businessCountry, countryFromText, countryName, googleCountryGeoId, normalizeCountryCode } from "../country";
import { googleDisplayName, googleKind, metaPlaceFromRow, parseMetaPlaceId, placeQuery } from "../places";

describe("the business's country is a structured fact, never a guess", () => {
  it("reads only the country fact (ISO code); a free-text location alone gives no country", async () => {
    h.facts = { location: { value: "Austin, TX" } };
    expect(await businessCountry("t")).toBeNull();
    h.facts = { location: { value: "Austin, TX" }, country: { value: "us" } };
    expect(await businessCountry("t")).toEqual({ code: "US", name: "United States" });
    h.facts = { country: { value: "ZZ" } };
    expect(await businessCountry("t")).toBeNull();
  });

  it("ISO codes only", () => {
    expect(normalizeCountryCode(" gb ")).toBe("GB");
    expect(normalizeCountryCode("UK")).toBeNull();
    expect(normalizeCountryCode(42)).toBeNull();
  });

  it("Google's country target is 2000 + the ISO numeric code (table fallback); unknown is null", () => {
    expect(googleCountryGeoId("US")).toBe(2840);
    expect(googleCountryGeoId("GB")).toBe(2826);
    expect(googleCountryGeoId("IN")).toBe(2356);
    expect(googleCountryGeoId("ZW")).toBeNull();
    expect(countryName("ZW")).toMatch(/Zimbabwe/);
  });

  it("the text reader only proposes: strict about state codes and region names", () => {
    expect(countryFromText("San Francisco, CA 94105")?.code).toBe("US");
    expect(countryFromText("Austin, Texas")?.code).toBe("US");
    expect(countryFromText("Albuquerque, New Mexico")?.code).toBe("US");
    expect(countryFromText("Sydney, New South Wales, Australia")?.code).toBe("AU");
    expect(countryFromText("London, UK")?.code).toBe("GB");
    expect(countryFromText("IN")).toBeNull();
    expect(countryFromText("United States and Canada")).toBeNull();
    expect(countryFromText("")).toBeNull();
  });
});

describe("places", () => {
  it("an address line searches for its city", () => {
    expect(placeQuery("410 Market St, San Francisco, CA 94105")).toBe("San Francisco");
    expect(placeQuery("Austin, TX")).toBe("Austin");
    expect(placeQuery("123")).toBe("");
  });

  it("Google names read like the picker: City, ST in the US, City, Country elsewhere, states and countries bare", () => {
    expect(googleDisplayName({ name: "San Francisco", canonical_name: "San Francisco,California,United States", target_type: "City", country_code: "US" })).toBe("San Francisco, CA");
    expect(googleDisplayName({ name: "Berlin", canonical_name: "Berlin,Berlin,Germany", target_type: "City", country_code: "DE" })).toBe("Berlin, Germany");
    expect(googleDisplayName({ name: "California", canonical_name: "California,United States", target_type: "State", country_code: "US" })).toBe("California");
    expect(googleKind("Province")).toBe("State");
    expect(googleKind("Postal Code")).toBe("Region");
  });

  it("Meta rows become typed ids; anything else is not a Meta place", () => {
    expect(metaPlaceFromRow({ key: "2420379", name: "San Francisco", type: "city", region: "California", country_code: "US" })).toEqual({
      id: "city:2420379",
      name: "San Francisco, California",
      kind: "City",
      country_code: "US",
    });
    expect(metaPlaceFromRow({ key: "x", name: "y", type: "zip" })).toBeNull();
    expect(parseMetaPlaceId("region:3847")).toEqual({ type: "region", key: "3847" });
    expect(parseMetaPlaceId("zip:US:94105")).toBeNull();
  });
});
