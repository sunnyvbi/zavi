import { describe, expect, it } from "vitest";
import { canonicalRedditUrl, firstRedditThreadUrl, redditPostId } from "../permalink";

const CANON = "https://www.reddit.com/r/saas/comments/1f5mjfs/";

describe("canonicalRedditUrl — every scraper/model shape becomes the one thread link", () => {
  it.each([
    ["full permalink with slug", "https://www.reddit.com/r/SaaS/comments/1f5mjfs/how_do_you_get_users/"],
    ["relative permalink (API `permalink` field)", "/r/SaaS/comments/1f5mjfs/how_do_you_get_users/"],
    ["relative without leading slash", "r/SaaS/comments/1f5mjfs/x/"],
    ["old.reddit", "https://old.reddit.com/r/SaaS/comments/1f5mjfs/x/"],
    ["np.reddit", "https://np.reddit.com/r/SaaS/comments/1f5mjfs/x/"],
    ["m.reddit", "https://m.reddit.com/r/SaaS/comments/1f5mjfs/x/"],
    ["amp.reddit", "https://amp.reddit.com/r/SaaS/comments/1f5mjfs/x/"],
    ["bare reddit.com over http", "http://reddit.com/r/SaaS/comments/1f5mjfs"],
    ["share tracking query", "https://www.reddit.com/r/SaaS/comments/1f5mjfs/x/?utm_source=share&utm_medium=web2x&context=3"],
    ["hash", "https://www.reddit.com/r/SaaS/comments/1f5mjfs/x/#comments"],
    ["comment permalink", "https://www.reddit.com/r/SaaS/comments/1f5mjfs/x/lk2ab9c/"],
    ["uppercase id + host", "HTTPS://WWW.REDDIT.COM/r/SaaS/comments/1F5MJFS/X/"],
    ["surrounding whitespace", "  https://www.reddit.com/r/SaaS/comments/1f5mjfs/  "],
  ])("%s", (_label, input) => {
    expect(canonicalRedditUrl(input)).toBe(CANON);
    expect(redditPostId(input)).toBe("1f5mjfs");
  });

  it("resolves redd.it and /comments/<id> short links only with a known subreddit", () => {
    expect(canonicalRedditUrl("https://redd.it/1f5mjfs", "r/SaaS")).toBe(CANON);
    expect(canonicalRedditUrl("https://redd.it/1f5mjfs/", "SaaS")).toBe(CANON);
    expect(canonicalRedditUrl("https://www.reddit.com/comments/1f5mjfs/x/", "/r/SaaS/")).toBe(CANON);
    expect(canonicalRedditUrl("https://redd.it/1f5mjfs")).toBeNull();
    expect(canonicalRedditUrl("https://www.reddit.com/comments/1f5mjfs/")).toBeNull();
    expect(canonicalRedditUrl("https://redd.it/1f5mjfs", "not a sub!")).toBeNull();
    expect(canonicalRedditUrl("https://www.reddit.com/r/SaaS/comments/1f5mjfs/", "other")).toBe(CANON);
  });

  it.each([
    ["external article of a link post", "https://techcrunch.com/2026/09/01/some-story/"],
    ["image host", "https://i.redd.it/abc123.png"],
    ["subreddit listing", "https://www.reddit.com/r/SaaS/"],
    ["subreddit top listing", "https://www.reddit.com/r/SaaS/top/?t=day"],
    ["share link (no post id in the URL)", "https://www.reddit.com/r/SaaS/s/AbCdEf123"],
    ["user profile post", "https://www.reddit.com/user/someone/comments/abc/x/"],
    ["lookalike host", "https://reddit.com.evil.example/r/SaaS/comments/1f5mjfs/"],
    ["lookalike suffix", "https://notreddit.com/r/SaaS/comments/1f5mjfs/"],
    ["javascript scheme", "javascript:alert(1)//reddit.com/r/SaaS/comments/1f5mjfs/"],
    ["empty", ""],
  ])("rejects %s", (_label, input) => {
    expect(canonicalRedditUrl(input)).toBeNull();
    expect(redditPostId(input)).toBeNull();
  });
});

describe("firstRedditThreadUrl", () => {
  it("skips non-thread Reddit links and strips trailing punctuation", () => {
    expect(
      firstRedditThreadUrl(
        "Rules at https://www.reddit.com/r/SaaS/about/rules/. Thread: https://old.reddit.com/r/SaaS/comments/1f5mjfs/x/?utm=1.",
      ),
    ).toBe(CANON);
    expect(firstRedditThreadUrl("see (https://www.reddit.com/r/SaaS/comments/1f5mjfs/x/), thanks")).toBe(CANON);
  });

  it("is null when the text has no thread link", () => {
    expect(firstRedditThreadUrl("reddit__thread_read: visible thread")).toBeNull();
    expect(firstRedditThreadUrl("https://www.reddit.com/r/SaaS/")).toBeNull();
    expect(firstRedditThreadUrl(null)).toBeNull();
  });
});
