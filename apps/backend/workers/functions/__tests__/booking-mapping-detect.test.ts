
import { describe, it, expect } from "vitest";
import { tenantsNeedingDetection } from "../booking-mapping-detect";

describe("tenantsNeedingDetection", () => {
  it("returns mongo tenants that have no booking_metric_config row", () => {
    expect(
      tenantsNeedingDetection(["a", "b", "c"], ["b"]),
    ).toEqual(["a", "c"]);
  });

  it("returns empty when every mongo tenant already has a config", () => {
    expect(tenantsNeedingDetection(["a", "b"], ["a", "b", "z"])).toEqual([]);
  });

  it("returns all mongo tenants when none are configured", () => {
    expect(tenantsNeedingDetection(["a", "b"], [])).toEqual(["a", "b"]);
  });

  it("de-dupes repeated mongo tenant ids and drops empties, order-stable", () => {
    expect(
      tenantsNeedingDetection(["a", "a", "", "b", "c", "b"], ["c"]),
    ).toEqual(["a", "b"]);
  });

  it("does not treat a configured-but-non-mongo tenant as needing detection", () => {
    expect(tenantsNeedingDetection([], ["pg-tenant"])).toEqual([]);
  });
});
