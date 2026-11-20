import { describe, it, expect, afterEach } from "vitest";
import { assertNoLabRefresh, ROTATING_REFRESH_PROVIDERS } from "../lab-mode";

describe("assertNoLabRefresh in the mirror process", () => {
  afterEach(() => {
    delete process.env.PRAXIS_MIRROR;
    delete process.env.PRAXIS_VARIANTS_LAB;
  });

  it("refuses every rotating provider", () => {
    process.env.PRAXIS_MIRROR = "1";
    for (const slug of ["jira", "x_social", "tiktok", "reddit_ads", "reddit_social", "microsoft_ads", "snapchat_ads", "pinterest_ads", "higgsfield"]) {
      expect(() => assertNoLabRefresh(slug)).toThrow(`mirror: ${slug} token expired`);
    }
    expect(ROTATING_REFRESH_PROVIDERS.size).toBe(9);
  });

  it("lets non-rotating providers refresh", () => {
    process.env.PRAXIS_MIRROR = "1";
    for (const slug of ["google_ads", "google_analytics", "linkedin_ads", "linkedin_social", "spotify_ads", "apple_ads"]) {
      expect(() => assertNoLabRefresh(slug)).not.toThrow();
    }
  });

  it("is a no-op outside the mirror and the lab", () => {
    expect(() => assertNoLabRefresh("jira")).not.toThrow();
  });

  it("the variants lab still refuses every provider, mirror flag or not", () => {
    process.env.PRAXIS_VARIANTS_LAB = "1";
    expect(() => assertNoLabRefresh("google_ads")).toThrow("variants lab: google_ads");
  });
});
