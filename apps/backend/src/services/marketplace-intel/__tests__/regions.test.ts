import { describe, expect, it } from "vitest";
import { MAX_REGIONS, NO_LOCATION_REGION, OTHER_REGION, buildRegionIndex, normalizeLocation } from "../regions";
import { usStateEvidence } from "../geo-resolver";

const w = (raw: unknown, weight = 10) => ({ raw, weight });

describe("usStateEvidence", () => {
  it("a two-letter tail that is also a country code is weak", () => {
    expect(usStateEvidence("Berlin, DE")).toEqual({ state: "DE", strength: "weak" });
    expect(usStateEvidence("Toronto, CA").strength).toBe("weak");
    expect(usStateEvidence("Mumbai, IN").strength).toBe("weak");
    expect(usStateEvidence("CA").strength).toBe("weak");
    expect(usStateEvidence("George Town, KY").strength).toBe("weak");
  });
  it("a state code that no country uses is strong", () => {
    expect(usStateEvidence("TX").strength).toBe("strong");
    expect(usStateEvidence("Pflugerville, TX")).toEqual({ state: "TX", strength: "strong" });
    expect(usStateEvidence("Tacoma, WA").strength).toBe("strong");
  });
  it("full state names, known US places, ZIPs and a USA suffix are strong", () => {
    expect(usStateEvidence("Texas")).toEqual({ state: "TX", strength: "strong" });
    expect(usStateEvidence("Austin, TX").strength).toBe("strong");
    expect(usStateEvidence("Austin TX").strength).toBe("strong");
    expect(usStateEvidence("Round Rock, TX 78664").strength).toBe("strong");
    expect(usStateEvidence("Smallville, KS, USA").strength).toBe("strong");
    expect(usStateEvidence("Denver").strength).toBe("strong");
  });
  it("places with no US reading are none", () => {
    expect(usStateEvidence("Lagos").strength).toBe("none");
    expect(usStateEvidence("Bavaria").strength).toBe("none");
  });
});

describe("buildRegionIndex", () => {
  it("never turns a foreign place into a US state", () => {
    const index = buildRegionIndex([w("Berlin, DE"), w("Toronto, CA"), w("Mumbai, IN"), w("Hamburg, DE")]);
    expect(index.mode).toBe("location");
    expect(index.resolve("Berlin, DE")).toEqual({ key: "berlin, de", label: "Berlin, DE", state: null });
    expect(index.resolve("Toronto, CA").state).toBeNull();
    expect(index.resolve("Mumbai, IN").state).toBeNull();
  });

  it("keeps unrecognized places as their own regions, not one unknown bucket", () => {
    const index = buildRegionIndex([w("Lagos"), w("Nairobi"), w("Accra")]);
    const keys = new Set(["Lagos", "Nairobi", "Accra"].map((p) => index.resolve(p).key));
    expect(keys.size).toBe(3);
  });

  it("merges spellings of the same place and labels with the commonest spelling", () => {
    const index = buildRegionIndex([w("Bavaria", 30), w("bavaria ", 2), w(" BAVARIA", 1)]);
    expect(index.resolve("bavaria ").key).toBe("bavaria");
    expect(index.resolve(" BAVARIA").label).toBe("Bavaria");
  });

  it("groups clearly-American data by state, joining city demand with state-code supply", () => {
    const index = buildRegionIndex([
      w("Austin, TX", 40), w("Houston", 30), w("Denver", 20), w("Boulder, CO", 5),
      w("TX", 12), w("CO", 8),
    ]);
    expect(index.mode).toBe("us_state");
    expect(index.resolve("Houston")).toEqual({ key: "TX", label: "Texas", state: "TX" });
    expect(index.resolve("TX").key).toBe("TX");
    expect(index.resolve("Boulder, CO").key).toBe("CO");
  });

  it("every US state code that is also an ISO country code stays ambiguous", () => {
    for (const code of ["AL", "AR", "AZ", "CA", "CO", "DE", "GA", "ID", "IL", "IN", "KY", "LA", "MA", "MD", "ME", "MN", "MO", "MS", "MT", "NC", "NE", "PA", "SC", "SD", "TN", "VA"]) {
      expect(usStateEvidence(`Somewhere, ${code}`).strength).toBe("weak");
    }
    expect(buildRegionIndex([w("George Town, KY"), w("Berlin, DE")]).mode).toBe("location");
  });

  it("codes that could be countries never switch on US grouping", () => {
    const index = buildRegionIndex([w("CA"), w("DE"), w("IN")]);
    expect(index.mode).toBe("location");
    expect(index.resolve("CA")).toEqual({ key: "ca", label: "CA", state: null });
  });

  it("a big listings table keyed by state codes cannot outvote the orders", () => {
    const index = buildRegionIndex([
      w("Austin, TX", 30), w("Denver", 20),
      w("CA", 5000), w("CO", 3000), w("TX", 4000),
    ]);
    expect(index.mode).toBe("us_state");
    expect(index.resolve("Austin, TX").key).toBe(index.resolve("TX").key);
    expect(index.resolve("Denver").key).toBe(index.resolve("CO").key);
  });

  it("small US towns with state codes still group by state", () => {
    const index = buildRegionIndex([w("Pflugerville, TX"), w("Round Rock, TX"), w("Loveland, CO")]);
    expect(index.mode).toBe("us_state");
    expect(index.resolve("Loveland, CO").key).toBe("CO");
  });

  it("one state is not enough for US grouping", () => {
    expect(buildRegionIndex([w("Austin, TX"), w("Houston"), w("Dallas")]).mode).toBe("location");
  });

  it("blanks go to No location; everything past the busiest locations goes to Other", () => {
    const inputs = Array.from({ length: MAX_REGIONS + 10 }, (_, i) => w(`Town ${i}`, 1000 - i));
    const index = buildRegionIndex([...inputs, w("", 50), w(null, 5)]);
    expect(index.resolve("   ").key).toBe(NO_LOCATION_REGION);
    expect(index.resolve(null).key).toBe(NO_LOCATION_REGION);
    expect(index.resolve("Town 0").key).toBe("town 0");
    expect(index.resolve(`Town ${MAX_REGIONS + 5}`).key).toBe(OTHER_REGION);
    expect(index.resolve("Never seen").key).toBe(OTHER_REGION);
  });

  it("an Other bucket a database read already folded does not take a location slot", () => {
    const inputs = Array.from({ length: MAX_REGIONS + 5 }, (_, i) => w(`Town ${i}`, 100));
    const index = buildRegionIndex([...inputs, w(OTHER_REGION, 5000)]);
    expect(index.resolve(OTHER_REGION).key).toBe(OTHER_REGION);
    const kept = inputs.map((x) => index.resolve(x.raw).key).filter((k) => k !== OTHER_REGION);
    expect(kept).toHaveLength(MAX_REGIONS);
  });

  it("normalizes whitespace, case and a trailing US ZIP", () => {
    expect(normalizeLocation("  Round   Rock, TX 78664 ")).toBe("round rock, tx");
    expect(normalizeLocation(undefined)).toBe("");
  });
});

describe("regionForKey", () => {
  it("returns the region a key came from, and Other for a key that was folded or unknown", () => {
    const places = Array.from({ length: MAX_REGIONS + 5 }, (_, i) => w(`Place ${i}`, 1000 - i));
    const index = buildRegionIndex([...places, w("lagos ", 5000), w("Lagos", 1)]);
    const lagos = index.resolve("Lagos");
    expect(index.regionForKey(lagos.key)).toEqual(lagos);
    expect(index.regionForKey(index.resolve(`Place ${MAX_REGIONS + 4}`).key).key).toBe(OTHER_REGION);
    expect(index.regionForKey("never seen").key).toBe(OTHER_REGION);
    expect(index.regionForKey(NO_LOCATION_REGION).key).toBe(NO_LOCATION_REGION);
  });
});
