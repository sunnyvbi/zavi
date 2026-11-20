import { describe, expect, it } from "vitest";
import { channelChrome, kpiFallbackMetrics } from "../agent/legacyChannelActions";

describe("Pinterest account metrics", () => {
  it("renders Pinterest's real metrics and previous daily values", () => {
    const metrics = [
      { key: "followers", value: 120, unit: "count", window_kind: null, day: "2026-10-16", grounded: true, prev_value: 100, prev_day: "2026-10-15" },
      { key: "impressions", value: 5400, unit: "count", window_kind: "30d", day: "2026-10-16", grounded: true, prev_value: 5000, prev_day: "2026-10-15" },
    ];
    const payload = {
      connected: true,
      account: { username: "dudhat0633", followers: 120 },
      metrics,
      refresh: { used: 1, cap: 3, remaining: 2 },
      problem: null,
    };
    expect(kpiFallbackMetrics("pinterest", payload)).toEqual([
      { ...metrics[0], note: "+20 since Oct 15" },
      { ...metrics[1], note: "+400 since Oct 15" },
    ]);
    expect(channelChrome("pinterest", payload)).toMatchObject({
      connected: true,
      account: { name: "@dudhat0633", sub: "120 followers · 2 of 3 refreshes left today" },
    });
  });
});
