import { describe, expect, it } from "vitest";
import { AD_CHANNEL_CONSTRAINTS, adConstraint, adConstraintForPlatform, smallestAcceptedDailyUsd } from "@zavi/shared";
import { TIKTOK_MIN_DAILY_USD } from "@/services/connectors/tiktok-ads/held-schema";
import { CHATGPT_MIN_DAILY_MICROS } from "@/services/connectors/chatgpt-ads/workspace";
import { PLATFORM_MIN_DAILY_USD } from "@/services/decisions/ad-budget-brake";

describe("ad channel constraints", () => {
  it("every row has verified_on and source", () => {
    for (const c of AD_CHANNEL_CONSTRAINTS) {
      expect(c.verified_on).toMatch(/^\d{4}-\d{2}-\d{2}$|^unverified$/);
      expect(c.source.length).toBeGreaterThan(5);
    }
  });
  it("ChatGPT: $25/day, lifetime and end date supported, 2x per-day hold", () => {
    expect(adConstraint("chatgpt_ads")).toMatchObject({ min_daily_usd: 25, lifetime: true, end_date: true, hold_factor: 2 });
    expect(CHATGPT_MIN_DAILY_MICROS).toBe(25_000_000);
  });
  it("TikTok: ad group must exceed $20, campaign minimum total $50 (official)", () => {
    const t = adConstraint("tiktok_ads")!;
    expect(smallestAcceptedDailyUsd(t)).toBe(20.01);
    expect(t.min_campaign_total_usd).toBe(50);
    expect(t.source).toContain("ads.tiktok.com/help/article/budget");
    expect(TIKTOK_MIN_DAILY_USD).toEqual({ campaign: 50, ad_group: 20 });
  });
  it("over-delivery factors: Meta 1.75, Google 2, ChatGPT 2, X 2, others 1; X is a code minimum", () => {
    expect(["meta_ads", "google_ads", "chatgpt_ads", "x_ads", "tiktok_ads", "reddit_ads", "linkedin_ads"].map((s) => adConstraint(s)!.hold_factor)).toEqual([1.75, 2, 2, 2, 1, 1, 1]);
    expect(adConstraint("x_ads")).toMatchObject({ min_daily_usd: 1, verified_on: "unverified" });
    expect(PLATFORM_MIN_DAILY_USD).toEqual({ meta: 1, google: 1, chatgpt: 25, reddit: 5, tiktok: 50, linkedin: 10 });
  });
  it("platform lookup takes the first row (google_ads, not youtube_ads)", () => {
    expect(adConstraintForPlatform("google")?.channel_slug).toBe("google_ads");
    expect(adConstraintForPlatform("nope")).toBeNull();
  });
});
