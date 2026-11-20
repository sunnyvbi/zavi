import { describe, expect, it } from "vitest";
import { channelChrome, extraTableData, kpiFallbackMetrics } from "./legacyChannelActions";

const payload = {
  page_url: "https://www.linkedin.com/company/acme/",
  account: { name: "Acme", followers: 10840 },
  metrics: [{ key: "followers", value: 10840, unit: null, window_kind: null, day: "2026-09-21", grounded: true, prev_value: null, prev_day: null }],
  top_posts: [{ id: "p1", url: "https://www.linkedin.com/posts/p1", text: "We are live", posted_at: "2026-08-28T12:00:00Z", reactions: 12, comments: 1, reposts: null }],
  refresh: { used: 1, cap: 3, remaining: 2 },
  problem: null,
};

describe("linkedin dashboard adapters", () => {
  it("passes the backend's numbers through, and answers [] for another shape", () => {
    expect(kpiFallbackMetrics("linkedin", payload).map((m) => m.key)).toEqual(["followers"]);
    expect(kpiFallbackMetrics("linkedin", { generic: true })).toEqual([]);
  });

  it("Top posts: no views column, and an unknown repost count is a dash, not a zero", () => {
    const [t] = extraTableData("linkedin_tables", payload);
    expect(t.columns.map((c) => c.label)).toEqual(["Post", "Reactions", "Comments", "Reposts", "Posted"]);
    expect(t.rows[0].cells.map((c) => c.text)).toEqual(["We are live", "12", "1", "-", "28 Aug"]);
    expect(extraTableData("linkedin_tables", { generic: true })).toEqual([]);
  });

  it("the account line carries followers and the refreshes left; never a Connect card", () => {
    const c = channelChrome("linkedin", payload);
    expect(c).toMatchObject({ connected: true, problem: null, account: { name: "Acme", sub: "10,840 followers · 2 of 3 refreshes left today" } });
    expect(channelChrome("linkedin", { ...payload, refresh: { used: 3, cap: 3, remaining: 0 } })?.account?.sub).toContain("No refreshes left today");
  });

  it("no saved page is a sentence pointing at Settings", () => {
    const c = channelChrome("linkedin", { ...payload, page_url: null, account: null });
    expect(c?.connected).toBe(true);
    expect(c?.problem?.text).toMatch(/Save your LinkedIn page in Settings/);
  });
});
