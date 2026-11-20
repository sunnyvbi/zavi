import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/consent", () => ({
  allowsAnalytics: (s: { status: string; prefs?: { analytics: boolean } }) =>
    s.status === "set" ? !!s.prefs?.analytics : true,
}));

import { allowsGoogleAnalytics, parseRegion, regionForCountry } from "./region";

const YES = { status: "set" as const, prefs: { analytics: true }, ts: "t" };
const NO = { status: "set" as const, prefs: { analytics: false }, ts: "t" };
const UNSET = { status: "unset" as const };

describe("region", () => {
  it("maps CloudFront countries", () => {
    expect(regionForCountry("DE")).toBe("eu");
    expect(regionForCountry("gb")).toBe("eu");
    expect(regionForCountry("NO")).toBe("eu");
    expect(regionForCountry("RE")).toBe("eu");
    expect(regionForCountry("JE")).toBe("eu");
    expect(regionForCountry("US")).toBe("other");
    expect(regionForCountry(null)).toBeNull();
    expect(regionForCountry("XX")).toBeNull();
    expect(regionForCountry("garbage")).toBeNull();
  });

  it("reads the cookie, unknown when missing or odd", () => {
    expect(parseRegion("a=1; zavi_region=eu")).toBe("eu");
    expect(parseRegion("zavi_region=other")).toBe("other");
    expect(parseRegion("zavi_region=mars")).toBe("unknown");
    expect(parseRegion("")).toBe("unknown");
  });

  it("GA needs an explicit yes in the EU/UK and when unknown; opt-out elsewhere", () => {
    for (const r of ["eu", "unknown"] as const) {
      expect(allowsGoogleAnalytics(UNSET, r)).toBe(false);
      expect(allowsGoogleAnalytics(NO, r)).toBe(false);
      expect(allowsGoogleAnalytics(YES, r)).toBe(true);
    }
    expect(allowsGoogleAnalytics(UNSET, "other")).toBe(true);
    expect(allowsGoogleAnalytics(NO, "other")).toBe(false);
  });
});
