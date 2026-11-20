import { describe, it, expect } from "vitest";
import {
  campaignsTableTitle,
  channelErrorBanner,
  dashboardCacheTimestampFresh,
  freshnessBadgeLabel,
  refreshCameBackStale,
} from "./PerformanceMarketerDashboard";

describe("campaignsTableTitle", () => {
  it("reads as a count, not a campaign name", () => {
    expect(campaignsTableTitle(7)).toBe("Your campaigns (7)");
  });

  it("handles singular and empty", () => {
    expect(campaignsTableTitle(1)).toBe("Your campaign (1)");
    expect(campaignsTableTitle(0)).toBe("Your campaigns (0)");
  });

  it("shows 'N of total' when the list is capped", () => {
    expect(campaignsTableTitle(50, 82)).toBe("Your campaigns (50 of 82)");
    expect(campaignsTableTitle(7, 7)).toBe("Your campaigns (7)");
    expect(campaignsTableTitle(7, undefined)).toBe("Your campaigns (7)");
  });
});

describe("refreshCameBackStale — silent keep-last-good detection", () => {
  it("flags an explicit refresh that got the last-good snapshot back", () => {
    expect(refreshCameBackStale(true, { served_last_good: true })).toBe(true);
  });

  it("a clean refresh is not flagged", () => {
    expect(refreshCameBackStale(true, { served_last_good: false })).toBe(false);
    expect(refreshCameBackStale(true, {})).toBe(false);
  });

  it("a plain load serving last-good is not a failed refresh", () => {
    expect(refreshCameBackStale(false, { served_last_good: true })).toBe(false);
  });
});

describe("freshnessBadgeLabel", () => {
  it("failed refresh leads with the failure and keeps the data age", () => {
    expect(freshnessBadgeLabel("Updated 263h ago", false, true)).toBe(
      "couldn't refresh · showing data from 263h ago",
    );
  });

  it("failed refresh without an age still says so", () => {
    expect(freshnessBadgeLabel("", false, true)).toBe("couldn't refresh");
    expect(freshnessBadgeLabel("Live", false, true)).toBe("couldn't refresh");
  });

  it("normal states pass through", () => {
    expect(freshnessBadgeLabel("Updated 5m ago", false, false)).toBe("Updated 5m ago");
    expect(freshnessBadgeLabel("Live", false, false)).toBe("Live");
    expect(freshnessBadgeLabel("Updated 5m ago", true, false)).toBe("Refreshing…");
    expect(freshnessBadgeLabel("Updated 5m ago", true, true)).toBe("Refreshing…");
  });
});

describe("dashboardCacheTimestampFresh", () => {
  const now = Date.parse("2026-07-29T08:00:00.000Z");

  it("rejects an already-stale in-memory snapshot before first paint", () => {
    expect(
      dashboardCacheTimestampFresh("2026-07-17T08:00:00.000Z", now),
    ).toBe(false);
  });

  it("keeps a genuinely fresh snapshot fast", () => {
    expect(
      dashboardCacheTimestampFresh("2026-07-29T07:00:00.000Z", now),
    ).toBe(true);
  });
});

describe("channelErrorBanner", () => {
  it("names a Meta throttle and its retry time instead of 'couldn't be reached'", () => {
    const err = { code: "meta_ads_busy", message: "Meta is busy for 5 min; try again after 10:14 UTC" };
    expect(channelErrorBanner("Meta", err, true)).toBe(
      "Meta is limiting requests right now. Showing the last good data. Try Refresh after 10:14 UTC.",
    );
  });

  it("recognises Graph's request-limit error on the first throttled read", () => {
    const err = { code: "meta_ads_query_failed", message: "Meta Ads request failed: 400 User request limit reached" };
    expect(channelErrorBanner("Meta", err, false)).toBe(
      "Meta is limiting requests right now. No data could be loaded for this range yet. Try Refresh in a few minutes.",
    );
  });

  it("only claims last-good data when it was served", () => {
    const err = { code: "query_failed", message: "socket hang up" };
    expect(channelErrorBanner("Google", err, false)).toBe(
      "Google couldn't be reached. No data could be loaded for this range yet. Try Refresh in a minute.",
    );
    expect(channelErrorBanner("Google", err, true)).toContain("Showing the last good data.");
  });
});
