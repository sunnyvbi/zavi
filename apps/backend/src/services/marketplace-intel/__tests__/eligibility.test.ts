import { describe, expect, it } from "vitest";
import { isSupplyDemandEligible, isSupplyDemandReachable } from "../eligibility";

const MAPPED = true;
const UNMAPPED = false;

describe("isSupplyDemandEligible", () => {
  it("shows for a tenant tagged marketplace, mapped or not", () => {
    expect(isSupplyDemandEligible("marketplace", UNMAPPED)).toBe(true);
    expect(isSupplyDemandEligible(" Marketplace ", UNMAPPED)).toBe(true);
    expect(isSupplyDemandEligible("marketplace", MAPPED)).toBe(true);
  });

  it("shows for an untagged tenant that has confirmed a mapping", () => {
    expect(isSupplyDemandEligible(null, MAPPED)).toBe(true);
    expect(isSupplyDemandEligible(undefined, MAPPED)).toBe(true);
  });

  it("hides for an untagged tenant that has only connected a database", () => {
    expect(isSupplyDemandEligible(null, UNMAPPED)).toBe(false);
    expect(isSupplyDemandEligible(undefined, UNMAPPED)).toBe(false);
  });

  it("an explicit non-marketplace tag hides it even with a confirmed mapping", () => {
    expect(isSupplyDemandEligible("saas", MAPPED)).toBe(false);
    expect(isSupplyDemandEligible("ecommerce", MAPPED)).toBe(false);
    expect(isSupplyDemandEligible("services", MAPPED)).toBe(false);
  });

  it('"other" is not a no: it behaves like untagged', () => {
    expect(isSupplyDemandEligible("other", MAPPED)).toBe(true);
    expect(isSupplyDemandEligible("other", UNMAPPED)).toBe(false);
  });

  it("junk shape values are treated as untagged", () => {
    expect(isSupplyDemandEligible(42, MAPPED)).toBe(true);
    expect(isSupplyDemandEligible(42, UNMAPPED)).toBe(false);
  });
});

describe("isSupplyDemandReachable", () => {
  it("keeps the page openable for untagged and marketplace tenants", () => {
    expect(isSupplyDemandReachable(null)).toBe(true);
    expect(isSupplyDemandReachable("other")).toBe(true);
    expect(isSupplyDemandReachable("marketplace")).toBe(true);
  });

  it("closes it for a tenant that said it is some other kind of company", () => {
    expect(isSupplyDemandReachable("saas")).toBe(false);
    expect(isSupplyDemandReachable("ecommerce")).toBe(false);
  });
});
