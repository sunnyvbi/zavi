import { describe, it, expect } from "vitest";
import { safeSearchContext } from "../company-facts-suggest";

describe("safeSearchContext — what may reach the competitor web-search query builder", () => {
  it("passes a plain category line through", () => {
    expect(safeSearchContext("Peer-to-peer fashion rental and resale marketplace")).toBe(
      "Peer-to-peer fashion rental and resale marketplace",
    );
    expect(safeSearchContext("P2P car rental marketplace")).toBe("P2P car rental marketplace");
  });

  it("drops an analogy so it can never become a search query", () => {
    for (const analogy of [
      "Airbnb for fashion",
      "the Airbnb of fashion",
      "A marketplace like Airbnb but for clothes",
      "positioned as the Uber of dog walking",
      "similar to Turo, for boats",
    ]) {
      expect(safeSearchContext(analogy)).toBe("");
    }
  });

  it("drops empty/absent input rather than inventing a seed", () => {
    expect(safeSearchContext(undefined)).toBe("");
    expect(safeSearchContext("")).toBe("");
    expect(safeSearchContext("   ")).toBe("");
  });

  it("returns a STRING always — findCompetitors treats '' as 'no context', never as a query", () => {
    for (const input of [undefined, "", "Airbnb for fashion", "P2P marketplace"]) {
      expect(typeof safeSearchContext(input)).toBe("string");
    }
  });
});
