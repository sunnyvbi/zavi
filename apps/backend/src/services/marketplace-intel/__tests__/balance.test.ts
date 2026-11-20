import { describe, expect, it } from "vitest";
import { relativeBalance } from "../balance";
import { NO_LOCATION_REGION, OTHER_REGION } from "../regions";

const labels = (m: ReturnType<typeof relativeBalance>) =>
  Object.fromEntries([...m.entries()].map(([k, v]) => [k, v.label]));

describe("relativeBalance", () => {
  it("sell-once goods: the city that sold out reads demand-heavy, the one that barely sold reads supply-heavy", () => {
    const out = relativeBalance([
      { key: "lagos", demand: 36, supply: 40 },
      { key: "nairobi", demand: 20, supply: 40 },
      { key: "accra", demand: 18, supply: 40 },
      { key: "kampala", demand: 4, supply: 40 },
    ]);
    expect(labels(out)).toEqual({
      lagos: "demand_heavy",
      nairobi: "balanced",
      accra: "balanced",
      kampala: "supply_heavy",
    });
    expect(out.get("lagos")?.demand_index).toBeCloseTo(2.57, 2);
  });

  it("a quiet marketplace whose locations differ by a few orders is not painted hot and cold", () => {
    const out = relativeBalance([
      { key: "a", demand: 6, supply: 10 },
      { key: "b", demand: 7, supply: 10 },
      { key: "c", demand: 5, supply: 10 },
      { key: "d", demand: 9, supply: 10 },
    ]);
    expect(new Set(Object.values(labels(out)))).toEqual(new Set(["balanced"]));
  });

  it("a big marketplace with a 4% spread is balanced everywhere", () => {
    const out = relativeBalance([
      { key: "a", demand: 1000, supply: 500 },
      { key: "b", demand: 1040, supply: 500 },
      { key: "c", demand: 980, supply: 500 },
      { key: "d", demand: 1010, supply: 500 },
    ]);
    expect(new Set(Object.values(labels(out)))).toEqual(new Set(["balanced"]));
  });

  it("two locations are not enough to compare", () => {
    const out = relativeBalance([
      { key: "a", demand: 90, supply: 10 },
      { key: "b", demand: 5, supply: 10 },
    ]);
    expect(labels(out)).toEqual({ a: "not_enough_locations", b: "not_enough_locations" });
  });

  it("sentinels are never labelled and never feed the comparison", () => {
    const withSentinels = relativeBalance([
      { key: "lagos", demand: 36, supply: 40 },
      { key: "nairobi", demand: 20, supply: 40 },
      { key: "accra", demand: 18, supply: 40 },
      { key: "kampala", demand: 4, supply: 40 },
      { key: OTHER_REGION, demand: 5000, supply: 3 },
      { key: NO_LOCATION_REGION, demand: 0, supply: 900 },
    ]);
    expect(withSentinels.get(OTHER_REGION)?.label).toBe("not_compared");
    expect(withSentinels.get(NO_LOCATION_REGION)?.label).toBe("not_compared");
    expect(withSentinels.get("lagos")?.label).toBe("demand_heavy");
  });

  it("unknown supply says so; tiny supply is insufficient; one region holding all supply cannot divide by zero", () => {
    const out = relativeBalance([
      { key: "unknown", demand: 50, supply: null },
      { key: "tiny", demand: 50, supply: 2 },
      { key: "all", demand: 50, supply: 100 },
      { key: "none1", demand: 0, supply: 3 },
    ]);
    expect(out.get("unknown")?.label).toBe("supply_unknown");
    expect(out.get("tiny")?.label).toBe("insufficient_data");
    expect(Number.isNaN(out.get("all")?.demand_index)).toBe(false);
  });
});
