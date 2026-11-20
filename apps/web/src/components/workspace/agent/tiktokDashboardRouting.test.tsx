import { describe, expect, it } from "vitest";
import { tiktok_ads } from "../actions/platforms/tiktok_ads";
import { tiktok_organic } from "../actions/platforms/tiktok_organic";
import { channelChrome, extraTableData, kpiFallbackMetrics } from "./legacyChannelActions";

describe("TikTok dashboard routing", () => {
  it("keeps paid campaign metrics separate from organic account metrics", () => {
    expect(tiktok_ads.kpiFallback).toBe("tiktok_ads");
    expect(tiktok_organic.kpiFallback).toBe("tiktok");
    const organic = {
      connected: true,
      account: { username: "creator", name: "Creator", followers: 100 },
      metrics: [{ key: "views", value: 250, grounded: true }],
      top_posts: [],
    };
    const paid = {
      platform: "tiktok_ads",
      connected: true,
      error_code: null,
      account: { name: "Advertiser", campaign_count: 0, currency: "USD" },
      totals: { spend: 10, impressions: 100, clicks: 2, conversions: 1, conv_value: 20, ctr: 2, cpa: 10, roas: 2 },
      campaigns: [],
    };

    expect(kpiFallbackMetrics("tiktok", organic)).toEqual(organic.metrics);
    expect(channelChrome("tiktok", organic)?.account?.name).toBe("@creator");
    expect(extraTableData("tiktok_tables", organic)[0].title).toBe("Top posts");
    expect(kpiFallbackMetrics("tiktok_ads", paid).map(({ key }) => key))
      .toEqual(["spend", "cpa", "conversions", "conv_value", "roas", "ctr"]);
    expect(channelChrome("tiktok_ads", paid)?.account?.name).toBe("Advertiser");
    expect(extraTableData("campaign_table", paid)[0].caption).toBe("Numbers as reported by TikTok Ads.");
    expect(kpiFallbackMetrics("tiktok", paid)).toEqual([]);
    expect(kpiFallbackMetrics("tiktok_ads", organic)).toEqual([]);
  });
});
