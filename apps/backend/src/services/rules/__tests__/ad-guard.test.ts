import { describe, it, expect } from "vitest";
import { adGuardEmpty, asAdGuard, EMPTY_AD_GUARD } from "../ad-guard";

describe("asAdGuard / adGuardEmpty", () => {
  it("a missing or malformed value is the empty set: no check", () => {
    expect(asAdGuard(null)).toEqual(EMPTY_AD_GUARD);
    expect(asAdGuard({ banned_phrases: "x", allowed_places: 3 })).toEqual(EMPTY_AD_GUARD);
    expect(adGuardEmpty(asAdGuard({}))).toBe(true);
  });
  it("any one saved list turns the check on", () => {
    expect(adGuardEmpty(asAdGuard({ banned_phrases: ["guaranteed"] }))).toBe(false);
    expect(adGuardEmpty(asAdGuard({ blocked_places: [{ id: "1", name: "Somewhere", kind: "City", platform: "google" }] }))).toBe(false);
  });
});
