const path = require("node:path");
const { loadTs } = require("./helpers/load-ts.cjs");
const { describe, it, expect } = require("./helpers/vitest-shim.cjs");

const R = loadTs(path.join(__dirname, "../src/features/channels/reddit.ts"));
const S = loadTs(path.join(__dirname, "../src/features/channels/channelSettings.ts"));
const NOW = Date.parse("2026-10-06T12:00:00Z");
const ago = (h) => new Date(NOW - h * 3600_000).toISOString();

const payload = (over = {}) => ({
  workspace_v2: true,
  workspace: {
    keywords: [{ term: "Upcar", type: "brand", status: "tracking" }],
    communities: [{ name: "turo", rules_verdict: "banned" }],
  },
  insights: {
    has_data: true,
    threshold: 60,
    sweep: { enabled: true, last: { status: "complete", started_at: ago(3), finished_at: ago(2) }, budget: { exhausted: false } },
    kpis: {
      brand_mentions: { value: 12, previous: 10 },
      reply_opportunities: { value: 5, previous: 0 },
      relevant_posts: { value: 12345, previous: 12345, scanned: 400 },
      relevant_comments: { value: 3, previous: null, scanned: 90 },
      subreddits: { value: 4 },
    },
    opportunities: [],
    lists: {
      brand_mentions: [
        { thread_id: "t1", url: "https://reddit.com/r/a/comments/1", subreddit: "a", title: "One", author: "bob", term: "Upcar", sentiment: "positive", score: 10, comment_count: 2, observed_at: ago(1) },
        { thread_id: "t1", url: "https://reddit.com/r/a/comments/1", subreddit: "a", title: "One", author: "bob", term: "upcar.ai", sentiment: "positive", score: 10, comment_count: 2, observed_at: ago(1), draft: { text: "Hi", state: "drafted" } },
        { thread_id: "t2", url: "https://reddit.com/r/b/comments/2", subreddit: "r/b", title: "Two", author: null, term: "Upcar", sentiment: null, score: 5, comment_count: null, observed_at: ago(30) },
      ],
      relevant_posts: [],
      relevant_comments: [],
    },
    communities: [
      { name: "turo", relevance: 80, relevance_why: "Hosts", subscribers: 12000, posts_per_day: 40, posts_per_day_capped: true, rules_verdict: null },
      { name: "cars", relevance: 20, relevance_why: null, subscribers: null, posts_per_day: null, rules_verdict: "allowed" },
    ],
  },
  ...over,
});

describe("numbers", () => {
  it("formats like web: grouped under 10K, then K and M", () => {
    expect(R.formatCount(1234)).toBe("1,234");
    expect(R.formatCount(12345)).toBe("12.3K");
    expect(R.formatCount(120000)).toBe("120K");
    expect(R.formatCount(1500000)).toBe("1.5M");
  });
  it("deltas: percent, absolute from zero, none when unchanged or unknown", () => {
    expect(R.kpiDelta(12, 10)).toEqual({ text: "+20%", up: true });
    expect(R.kpiDelta(5, 0)).toEqual({ text: "+5", up: true });
    expect(R.kpiDelta(1, 2)).toEqual({ text: "-50%", up: false });
    expect(R.kpiDelta(3, 3)).toBeNull();
    expect(R.kpiDelta(3, null)).toBeNull();
  });
  it("five tiles in web order; subreddits never has a delta", () => {
    const t = R.redditTiles(payload());
    expect(t.map((x) => x.label)).toEqual(["Brand mentions", "Reply opportunities", "Relevant posts", "Relevant comments", "Subreddits saved"]);
    expect(t[0].delta).toEqual({ text: "+20%", up: true });
    expect(t[4].delta).toBeNull();
    expect(t[2].value).toBe("12.3K");
  });
  it("before the first scan: dashes and no tables", () => {
    const p = payload({ insights: { has_data: false } });
    expect(R.redditTiles(p).every((x) => x.value === "—")).toBe(true);
    expect(R.redditTable(p, "brand")).toBeNull();
  });
  it("the kill switch is an explicit false only", () => {
    expect(R.redditOff({ workspace_v2: false })).toBe(true);
    expect(R.redditOff({})).toBe(false);
  });
});

describe("tables", () => {
  it("brand mentions dedupe by thread, list every term, and caption the tracked brand", () => {
    const t = R.redditTable(payload(), "brand");
    expect(t.rows).toHaveLength(2);
    expect(t.columns.map((c) => c.label)).toEqual(["Thread", "Term", "Sentiment", "Upvotes", "Comments", "Age"]);
    expect(t.rows[0].cells[1]).toEqual({ kind: "text", text: "Upcar, upcar.ai" });
    expect(t.rows[0].cells[0].sub).toBe("r/a · u/bob");
    expect(t.rows[1].cells[0].sub).toBe("r/b");
    expect(t.rows[1].cells[2]).toEqual({ kind: "text", text: "—", dim: true });
    expect(t.footer).toEqual(["2 threads", "", "", "15", "2", ""]);
    expect(t.caption).toBe("12 mentions of Upcar in what Zavi scanned. Newest first; sentiment is inferred by Zavi.");
    expect(t.rows[0].action).toEqual({ kind: "draft", threadId: "t1", draft: null });
  });
  it("subreddits: the founder's reading wins, low relevance goes to the tail", () => {
    const t = R.redditTable(payload(), "subreddits");
    expect(t.tailFrom).toBe(1);
    expect(t.rows[0].cells[3]).toEqual({ kind: "text", text: "40+", align: "right" });
    expect(t.rows[0].cells[4]).toEqual({ kind: "verdict", name: "turo", value: "banned" });
    expect(t.rows[1].cells[4].value).toBe("allowed");
  });
  it("empty copy names the relevance threshold", () => {
    expect(R.redditTable(payload(), "posts").empty).toBe("No posts scored 60+ today. Scan again later or add keywords.");
  });
});

describe("scan control", () => {
  it("fresh only after a finished scan in the last 24 hours", () => {
    expect(R.scanState(payload(), NOW)).toEqual({ lastAt: ago(2), fresh: true, running: false, enabled: true, budgetExhausted: false });
    const failed = payload();
    failed.insights.sweep.last.status = "failed";
    expect(R.scanState(failed, NOW).fresh).toBe(false);
  });
  it("says why it can't scan, and maps every error", () => {
    expect(R.scanBlocked({ enabled: false, budgetExhausted: false })).toBe("Reddit scanning is turned off.");
    expect(R.scanError(409)).toBe("A scan is already running.");
    expect(R.scanError(422, { reason: "not_configured" })).toBe("Reddit scanning isn't set up yet.");
    expect(R.scanError(422, {})).toBe("Track a keyword, a competitor or a subreddit first, then scan.");
    expect(R.scanError(null)).toBe("Couldn't reach Zavi. Check your connection.");
  });
});

describe("communities verdict", () => {
  it("sets an existing row's type, or adds a new one paused when banned", () => {
    expect(R.withVerdict([{ item: "r/Turo", status: "tracking" }], "turo", "allowed")).toEqual([{ item: "r/Turo", status: "tracking", item_type: "allowed" }]);
    expect(R.withVerdict([], "r/cars", "banned")).toEqual([{ item: "cars", item_type: "banned", status: "paused", origin: "custom" }]);
  });
});

describe("settings lists", () => {
  const keywords = R.REDDIT_SETTINGS[0];
  it("add tracks a new custom row with the first type, or re-tracks an existing one", () => {
    expect(S.addItem([], "  turo host ", keywords)).toEqual([{ item: "turo host", item_type: "problem", status: "tracking", origin: "custom" }]);
    expect(S.addItem([{ item: "x", status: "dismissed" }], "x", keywords)).toEqual([{ item: "x", status: "tracking" }]);
  });
  it("hides old suggestions until Suggest is pressed, and says so", () => {
    const items = [{ item: "a", status: "suggested" }];
    expect(S.visibleItems(items, keywords, false)).toEqual([]);
    expect(S.visibleItems(items, keywords, true)).toHaveLength(1);
    expect(S.emptyListText(items, [])).toBe(
      "1 suggestion from an earlier run is hidden, because a suggestion goes stale. Press Suggest for a fresh set, or type a term to track it directly.",
    );
    expect(S.emptyListText([], [])).toBe("Nothing here yet. Zavi uses the whole channel until you narrow it.");
  });
  it("a PUT sends stored fields only, without ids or nulls", () => {
    expect(S.putItems([{ id: "1", item: "a", item_type: null, status: "tracking", note: "why" }])).toEqual([{ item: "a", status: "tracking", note: "why" }]);
  });
  it("toggle and choice values are the first row", () => {
    expect(S.toggleOn([{ item: "on" }])).toBe(true);
    expect(S.toggleOn([])).toBe(false);
    expect(S.firstItem([{ item: "own_organic" }])).toBe("own_organic");
    expect(S.firstItem([])).toBeNull();
  });
});

describe("every channel's settings (web platforms/*.ts settings)", () => {
  const C = loadTs(path.join(__dirname, "../src/features/channels/settingsConfig.ts"));
  it("declares fields for the channels web does, and none for the ones it doesn't", () => {
    expect(Object.keys(C.CHANNEL_SETTINGS).sort()).toEqual([
      "chatgpt_ads", "email_marketing", "google_ads", "instagram_organic", "linkedin_ads", "linkedin_organic",
      "pinterest_organic", "reddit_ads", "reddit_organic", "sms", "tiktok_ads", "tiktok_organic", "ugc", "x_ads", "youtube_organic",
    ]);
    expect(C.settingsFor("x_organic")).toBeNull();
    expect(C.settingsFor("meta_ads")).toBeNull();
    expect(C.settingsFor("ugc").map((f) => f.id)).toEqual(["run_surface", "claims_off_limits"]);
  });
  it("every field has an id, a label and a kind the form draws", () => {
    for (const [slug, fields] of Object.entries(C.CHANNEL_SETTINGS)) {
      for (const f of fields) {
        expect(["list", "choice", "toggle", "number", "text"].includes(f.kind), `${slug}.${f.id}`).toBe(true);
        expect(!!f.id && !!f.label, `${slug}.${f.id}`).toBe(true);
      }
    }
  });
  it("Google Ads' budget is read-only here: it is saved with the channel's budget", () => {
    const budget = C.settingsFor("google_ads").find((f) => f.id === "budget");
    expect(C.elsewhereText(budget)).toBe("Saved with the channel's budget, where pacing reads it. Changing it here would make a second copy.");
    expect(C.elsewhereText(C.settingsFor("google_ads").find((f) => f.id === "tcpa"))).toBeNull();
  });
});
