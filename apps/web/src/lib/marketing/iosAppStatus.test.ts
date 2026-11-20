import { describe, it, expect } from "vitest";
import { parseIosAppStoreLive } from "./iosAppStatus";

describe("parseIosAppStoreLive", () => {
  it("is live only when the backend says exactly true", () => {
    expect(parseIosAppStoreLive({ isIosAppStoreLive: true })).toBe(true);
  });

  it("fails closed on false, a missing field, or junk", () => {
    expect(parseIosAppStoreLive({ isIosAppStoreLive: false })).toBe(false);
    expect(parseIosAppStoreLive({ isSignupEnabled: true })).toBe(false);
    expect(parseIosAppStoreLive({ isIosAppStoreLive: "true" })).toBe(false);
    expect(parseIosAppStoreLive(null)).toBe(false);
  });
});
