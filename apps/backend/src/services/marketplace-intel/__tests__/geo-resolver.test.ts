import { describe, expect, it } from "vitest";
import {
  AMBIGUOUS_CITY_NAMES,
  resolveGeo,
  resolveGeos,
  summarizeGeos,
} from "../geo-resolver";

describe("resolveGeo", () => {
  it("resolves explicit City, ST labels with high confidence", () => {
    expect(resolveGeo("San Francisco, CA")).toMatchObject({
      country: "US",
      state: "CA",
      geo_label: "San Francisco, CA",
      confidence: "high",
      raw: "San Francisco, CA",
    });

    expect(resolveGeo("Austin, Texas")).toMatchObject({
      country: "US",
      state: "TX",
      geo_label: "Austin, TX",
      confidence: "high",
    });
  });

  it("resolves unambiguous major city names with high confidence", () => {
    expect(resolveGeo("San Francisco")).toMatchObject({
      country: "US",
      state: "CA",
      confidence: "high",
    });
    expect(resolveGeo("Austin")).toMatchObject({
      country: "US",
      state: "TX",
      confidence: "high",
    });
    expect(resolveGeo("Miami")).toMatchObject({
      country: "US",
      state: "FL",
      confidence: "high",
    });
  });

  it("resolves metro aliases with medium confidence when a single state is honest", () => {
    expect(resolveGeo("Bay Area")).toMatchObject({
      country: "US",
      state: "CA",
      geo_label: "Bay Area, CA",
      confidence: "medium",
    });
    expect(resolveGeo("DFW")).toMatchObject({
      country: "US",
      state: "TX",
      geo_label: "Dallas-Fort Worth, TX",
      confidence: "medium",
    });
    expect(resolveGeo("LA Metro")).toMatchObject({
      country: "US",
      state: "CA",
      confidence: "medium",
    });
  });

  it("recognizes multi-state or ambiguous metro labels without inventing a state", () => {
    expect(resolveGeo("DMV")).toMatchObject({
      country: "US",
      state: null,
      geo_label: "DMV / DC metro (multi-state)",
      confidence: "medium",
    });

    expect(resolveGeo("Tri-State")).toMatchObject({
      country: null,
      state: null,
      geo_label: "unknown_state",
      confidence: "none",
    });
  });

  it("does not guess explicitly ambiguous bare city names", () => {
    expect(resolveGeo("Portland")).toMatchObject({
      country: "US",
      state: null,
      confidence: "low",
    });
    expect(resolveGeo("Springfield")).toMatchObject({
      country: "US",
      state: null,
      confidence: "low",
    });
    expect(resolveGeo("Kansas City")).toMatchObject({
      country: "US",
      state: null,
      confidence: "low",
    });
    expect(AMBIGUOUS_CITY_NAMES.has("glendale")).toBe(true);
    expect(AMBIGUOUS_CITY_NAMES.has("aurora")).toBe(true);
  });

  it("allows ambiguous city names when the state is explicit", () => {
    expect(resolveGeo("Portland, OR")).toMatchObject({
      country: "US",
      state: "OR",
      geo_label: "Portland, OR",
      confidence: "high",
    });
    expect(resolveGeo("Kansas City, KS")).toMatchObject({
      country: "US",
      state: "KS",
      geo_label: "Kansas City, KS",
      confidence: "high",
    });
  });

  it("resolves explicit state code or state name alone with high confidence", () => {
    expect(resolveGeo("CA")).toMatchObject({
      country: "US",
      state: "CA",
      geo_label: "California (CA)",
      confidence: "high",
    });
    expect(resolveGeo("Florida")).toMatchObject({
      country: "US",
      state: "FL",
      geo_label: "Florida (FL)",
      confidence: "high",
    });
  });

  it("normalizes whitespace, case, trailing country, and trailing zip codes", () => {
    expect(resolveGeo("  sAn   fRaNcIsCo,   ca  94105, USA ")).toMatchObject({
      country: "US",
      state: "CA",
      geo_label: "San Francisco, CA",
      confidence: "high",
    });

    expect(resolveGeo("austin, texas 78701 United States")).toMatchObject({
      country: "US",
      state: "TX",
      geo_label: "Austin, TX",
      confidence: "high",
    });
  });

  it("resolves snake_case booking geo slugs without guessing unknown buckets", () => {
    expect(resolveGeo("bay_area")).toMatchObject({
      country: "US",
      state: "CA",
      geo_label: "Bay Area, CA",
      confidence: "medium",
    });
    expect(resolveGeo("los_angeles")).toMatchObject({
      country: "US",
      state: "CA",
      geo_label: "Los Angeles, CA",
      confidence: "high",
    });
    expect(resolveGeo("las_vegas")).toMatchObject({
      country: "US",
      state: "NV",
      geo_label: "Las Vegas, NV",
      confidence: "high",
    });
    expect(resolveGeo("glendale_az")).toMatchObject({
      country: "US",
      state: "AZ",
      geo_label: "Glendale, AZ",
      confidence: "high",
    });
    expect(resolveGeo("fort_worth")).toMatchObject({
      country: "US",
      state: "TX",
      geo_label: "Fort Worth, TX",
      confidence: "high",
    });
    expect(resolveGeo("san_diego")).toMatchObject({
      country: "US",
      state: "CA",
      geo_label: "San Diego, CA",
      confidence: "high",
    });
    expect(resolveGeo("fort_lauderdale")).toMatchObject({
      country: "US",
      state: "FL",
      geo_label: "Fort Lauderdale, FL",
      confidence: "high",
    });
    expect(resolveGeo("san_antonio")).toMatchObject({
      country: "US",
      state: "TX",
      geo_label: "San Antonio, TX",
      confidence: "high",
    });
    expect(resolveGeo("pearland")).toMatchObject({
      country: "US",
      state: "TX",
      geo_label: "Pearland, TX",
      confidence: "high",
    });
    expect(resolveGeo("other")).toMatchObject({
      country: null,
      state: null,
      geo_label: "unknown_state",
      confidence: "none",
    });
  });

  it("returns none for garbage, international, and empty inputs", () => {
    for (const raw of ["", "   ", "Toronto", "London, UK", "not a place !!!"]) {
      expect(resolveGeo(raw)).toMatchObject({
        country: null,
        state: null,
        geo_label: "unknown_state",
        confidence: "none",
      });
    }
  });
});

describe("resolveGeos and summarizeGeos", () => {
  it("resolves batches in order", () => {
    expect(resolveGeos(["San Francisco", "Austin", "Portland"]).map((geo) => geo.state)).toEqual([
      "CA",
      "TX",
      null,
    ]);
  });

  it("counts resolved, unresolved, and state rollups", () => {
    expect(
      summarizeGeos(["San Francisco", "Bay Area", "Austin", "Portland", "", "DMV"]),
    ).toEqual({
      total: 6,
      resolved: 3,
      unresolved: 3,
      state_rollup: {
        CA: 2,
        TX: 1,
        unknown_state: 3,
      },
    });
  });
});
