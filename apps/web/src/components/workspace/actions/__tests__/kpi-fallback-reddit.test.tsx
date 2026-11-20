
import { describe, expect, it } from "vitest";
import { channelChrome, kpiFallbackMetrics, redditKpisToMetrics } from "../../agent/legacyChannelActions";
import type { RedditPayload } from "../../agent/reddit/shared";
import { DEFAULT_RANGES } from "../../agent/google-ads/types";

const REDDIT_PAYLOAD = {
  connected: false,
  manual_publish: true,
  research_summary: null,
  suggestions: [],
  insights: {
    has_data: true,
    kpis: {
      brand_mentions: { value: 24, previous: 20, brand_terms: 1 },
      reply_opportunities: { value: 31, previous: 22, on_google: null },
      relevant_posts: { value: 12, previous: 9, scanned: 400 },
      relevant_comments: { value: 8, previous: null, scanned: 900 },
      subreddits: { value: 2, top: null },
    },
  },
};

const COUNT = { unit: "count", window_kind: null, day: "", grounded: true, prev_day: null };

describe("Reddit's five headline numbers", () => {
  it("reads every one off the payload's own kpis, with its own previous value", () => {
    expect(kpiFallbackMetrics("reddit", REDDIT_PAYLOAD)).toEqual([
      { key: "brand_mentions", value: 24, prev_value: 20, ...COUNT },
      { key: "reply_opportunities", value: 31, prev_value: 22, ...COUNT },
      { key: "relevant_posts", value: 12, prev_value: 9, ...COUNT },
      { key: "relevant_comments", value: 8, prev_value: null, ...COUNT },
      { key: "subreddits", value: 2, prev_value: null, ...COUNT },
    ]);
  });

  it("answers no numbers at all until a scan has finished", () => {
    expect(kpiFallbackMetrics("reddit", { ...REDDIT_PAYLOAD, insights: { has_data: false } })).toEqual([]);
    expect(kpiFallbackMetrics("reddit", { ...REDDIT_PAYLOAD, insights: null })).toEqual([]);
    expect(kpiFallbackMetrics("reddit", { generic: true })).toEqual([]);
  });

  it("keeps a number the payload could not read on screen, marked unverified", () => {
    const missing = {
      ...REDDIT_PAYLOAD,
      insights: { ...REDDIT_PAYLOAD.insights, kpis: { ...REDDIT_PAYLOAD.insights.kpis, subreddits: {} } },
    };
    const row = kpiFallbackMetrics("reddit", missing).find((m) => m.key === "subreddits")!;
    expect(Number.isNaN(row.value)).toBe(true);
    expect(row.grounded).toBe(false);
  });

  it("never offers to connect a Reddit account, because the numbers do not need one", () => {
    expect(channelChrome("reddit", REDDIT_PAYLOAD)).toEqual({
      connected: true,
      ranges: [],
      period: null,
      account: null,
      problem: null,
      plan: null,
    });
  });
});

describe("a number Reddit did not scan today", () => {
  const unscanned = {
    ...REDDIT_PAYLOAD,
    insights: {
      ...REDDIT_PAYLOAD.insights,
      kpis: {
        brand_mentions: { value: 0, previous: 20, brand_terms: 1, scanned: 0 },
        reply_opportunities: { value: 0, previous: 22, on_google: null },
        relevant_posts: { value: 0, previous: 9, scanned: 0 },
        relevant_comments: { value: 0, previous: 5, scanned: 0 },
        subreddits: { value: 2, top: null },
      },
    },
  };

  it("says it was not scanned and drops the earlier value, so no -100% is drawn", () => {
    expect(redditKpisToMetrics(unscanned as unknown as RedditPayload)).toEqual([
      { key: "brand_mentions", value: 0, prev_value: null, unmeasured: "Not scanned this week", ...COUNT },
      { key: "reply_opportunities", value: 0, prev_value: 22, ...COUNT },
      { key: "relevant_posts", value: 0, prev_value: null, unmeasured: "Not scanned today", ...COUNT },
      { key: "relevant_comments", value: 0, prev_value: null, unmeasured: "Not scanned today", ...COUNT },
      { key: "subreddits", value: 2, prev_value: null, ...COUNT },
    ]);
  });

  it("leaves a scanned zero as a real zero with its delta", () => {
    const scannedZero = {
      ...unscanned,
      insights: { ...unscanned.insights, kpis: { ...unscanned.insights.kpis, relevant_posts: { value: 0, previous: 9, scanned: 400 } } },
    };
    const posts = redditKpisToMetrics(scannedZero as unknown as RedditPayload).find((m) => m.key === "relevant_posts")!;
    expect(posts).toEqual({ key: "relevant_posts", value: 0, prev_value: 9, ...COUNT });
    expect(posts).not.toHaveProperty("unmeasured");
  });

  it("treats a payload with no scanned count as scanned", () => {
    const rows = redditKpisToMetrics(REDDIT_PAYLOAD as unknown as RedditPayload);
    expect(rows.some((m) => "unmeasured" in m)).toBe(false);
  });
});

const GADS_PAYLOAD = {
  connected: true,
  error_code: null,
  window_days: 30,
  period: { from: "2026-08-20", to: "2026-09-18" },
  prev_period: { from: "2026-07-21", to: "2026-08-19" },
  account: null,
  kpis: [
    { key: "spend", label: "Spend", value: 4820, prev: 4000, delta_pct: null, delta_abs: null, delta_good: null, unit: "usd" },
    { key: "cpa", label: "Cost per conversion", value: null, prev: null, delta_pct: null, delta_abs: null, delta_good: null, unit: "usd" },
  ],
  campaigns: [],
  totals: null,
  actions: [],
  counts: { all: 0, needs_you: 0, autonomous: 0 },
};

const X_PAYLOAD = {
  period: { from: "2026-09-12", to: "2026-09-18" },
  metrics: [
    { key: "impressions", label: "Impressions", value: 1200, unit: "count", delta: 20, delta_unit: "pct", basis: "period" },
    { key: "engagement_rate", label: "Engagement rate", value: 3.4, unit: "pct", delta: 0.4, delta_unit: "pp", basis: "period" },
  ],
};

describe("Google Ads and X are untouched by the third id", () => {
  it("answers Google's numbers exactly as before", () => {
    expect(kpiFallbackMetrics("gads", GADS_PAYLOAD)).toEqual([
      {
        key: "spend",
        value: 4820,
        unit: "usd",
        window_kind: "30d",
        day: "2026-09-18",
        grounded: true,
        prev_value: 4000,
        prev_day: "2026-08-19",
      },
      {
        key: "cpa",
        value: Number.NaN,
        unit: "usd",
        window_kind: "30d",
        day: "2026-09-18",
        grounded: false,
        prev_value: null,
        prev_day: null,
      },
    ]);
  });

  it("answers Google's chrome with the account's count and no second sentence", () => {
    expect(channelChrome("gads", GADS_PAYLOAD)).toEqual({
      connected: true,
      ranges: DEFAULT_RANGES,
      period: { from: "2026-08-20", to: "2026-09-18" },
      account: { name: null, sub: "Campaigns could not be read" },
      problem: null,
      plan: null,
    });
  });

  it("answers X's numbers exactly as before, and X still draws no chrome", () => {
    expect(kpiFallbackMetrics("x", X_PAYLOAD)).toEqual([
      {
        key: "impressions",
        value: 1200,
        unit: "count",
        window_kind: null,
        day: "2026-09-18",
        grounded: true,
        prev_value: 1000,
        prev_day: null,
      },
      {
        key: "engagement_rate",
        value: 3.4,
        unit: "pct",
        window_kind: null,
        day: "2026-09-18",
        grounded: true,
        prev_value: 3,
        prev_day: null,
      },
    ]);
    expect(channelChrome("x", X_PAYLOAD)).toBeNull();
  });
});
