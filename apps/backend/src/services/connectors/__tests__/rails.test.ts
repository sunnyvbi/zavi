import { describe, it, expect } from "vitest";
import { railFor, RAIL_OVERRIDES } from "@zavi/shared";

describe("railFor (spec 16-17)", () => {
  it("overrides win: Instagram, YouTube and Reddit ride Composio", () => {
    expect(railFor("instagram")).toBe("composio");
    expect(railFor("youtube")).toBe("composio");
    expect(railFor("reddit")).toBe("composio");
  });
  it("an app with a native connector is native (Stripe and the spec 14 overlap set)", () => {
    for (const k of ["stripe", "linear", "figma", "sentry", "googlecalendar", "googlesheets", "linkedin", "slack", "posthog", "sendgrid"])
      expect(railFor(k)).toBe("native");
  });
  it("GA + Search Console ride Composio while our Google app's scope verification is pending (rails.ts flip-back note)", () => {
    expect(railFor("google_analytics")).toBe("composio");
    expect(railFor("google_search_console")).toBe("composio");
  });
  it("everything else is Composio (including apps spec 17 does not list as native)", () => {
    for (const k of ["notion", "gmail", "googledrive", "facebook", "intercom", "discord", "whatsapp"])
      expect(railFor(k)).toBe("composio");
  });
  it("normalizes case; prototype keys are not overrides", () => {
    expect(railFor("INSTAGRAM")).toBe("composio");
    expect(railFor("constructor")).toBe("composio");
    expect(railFor("__proto__")).toBe("composio");
  });
  it("Pipedream is not a rail value", () => {
    expect(new Set(Object.values(RAIL_OVERRIDES))).toEqual(new Set(["composio"]));
    expect(["native", "composio"]).toContain(railFor("pipedream"));
  });
});
