
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { callApifyTool } from "../apify";

const TENANT = "00000000-0000-0000-0000-000000000000";

function captureFetch(items: unknown[]) {
  const seen: { url: string; body: Record<string, unknown> }[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    seen.push({
      url: url.toString(),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return new Response(JSON.stringify(items), {
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
    });
  }) as typeof fetch;
  return { fn, seen };
}

const POST = {
  dataType: "post",
  title: "Sent 50 cold emails, got 0 responses",
  postUrl: "https://www.reddit.com/r/SaaS/comments/abc/",
  communityName: "r/SaaS",
  authorName: "someone",
  score: 7,
  upVotes: 7,
  upvoteRatio: 0.86,
  commentsCount: 12,
  subredditSubscribers: 2533520,
  ageHours: 5.8782,
  postType: "text",
  outboundUrlHost: null,
  removedBy: null,
  locked: false,
  body: "x".repeat(3000),
  bodyHtml: "<div>noise</div>",
  mediaMetadata: { junk: true },
};

const COMMUNITY = {
  dataType: "community",
  name: "ColdEmailAndSales",
  title: "Cold Email and Sales",
  subscribers: null,
  description: "1. Share what you learned, not what you sell. 2. Disclose your affiliation.",
};

describe("scrape_reddit", () => {
  beforeEach(() => {
    process.env.APIFY_TOKEN = "test-token";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.APIFY_TOKEN;
  });

  it("pins searchSort to relevance on post search — `top` answers a different question", async () => {
    const { fn, seen } = captureFetch([POST]);
    vi.stubGlobal("fetch", fn);

    const res = await callApifyTool(TENANT, "scrape_reddit", {
      mode: "search_posts",
      query: "cold email deliverability",
      searchSort: "top",
    });

    expect(res.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].body.searchSort).toBe("relevance");
    expect(seen[0].body.searchPosts).toBe(true);
    expect(seen[0].body.searchCommunities).toBe(false);
  });

  it("asks for communities, not posts, in communities mode", async () => {
    const { fn, seen } = captureFetch([COMMUNITY]);
    vi.stubGlobal("fetch", fn);

    const res = await callApifyTool(TENANT, "scrape_reddit", {
      mode: "communities",
      query: "cold email",
      max_items: 5,
    });

    expect(res.ok).toBe(true);
    expect(seen[0].body.searchCommunities).toBe(true);
    expect(seen[0].body.searchPosts).toBe(false);
    expect(seen[0].body.maxCommunitiesCount).toBe(5);
    expect(seen[0].body.maxPostsCount).toBe(0);

    const out = JSON.parse(res.content) as { communities: { description: string }[] };
    expect(out.communities[0].description).toContain("Disclose your affiliation");
  });

  it("puts the sort in the URL for a subreddit read", async () => {
    const { fn, seen } = captureFetch([POST]);
    vi.stubGlobal("fetch", fn);

    await callApifyTool(TENANT, "scrape_reddit", {
      mode: "subreddit",
      subreddit: "smallbusiness",
      time: "month",
    });

    expect(seen[0].body.startUrls).toEqual([
      { url: "https://www.reddit.com/r/smallbusiness/top/?t=month" },
    ]);
  });

  it("refuses a subreddit that is a path or a URL, not a bare name", async () => {
    const { fn, seen } = captureFetch([POST]);
    vi.stubGlobal("fetch", fn);

    for (const bad of ["r/evil", "https://evil.example.com/", "small/../../x", "a b"]) {
      const res = await callApifyTool(TENANT, "scrape_reddit", {
        mode: "subreddit",
        subreddit: bad,
      });
      expect(res.is_error, bad).toBe(true);
    }
    expect(seen).toHaveLength(0);
  });

  it("fails LOUD on an empty actor result instead of returning an empty object", async () => {
    const { fn } = captureFetch([]);
    vi.stubGlobal("fetch", fn);

    const res = await callApifyTool(TENANT, "scrape_reddit", {
      mode: "subreddit",
      subreddit: "thissubdoesnotexist",
    });

    expect(res.ok).toBe(false);
    expect(res.is_error).toBe(true);
    expect(res.content).toContain("tool_no_data");
    expect(res.content).toContain("UNVERIFIED");
  });

  it("normalizes a post to the judgement fields and drops the noise", async () => {
    const { fn } = captureFetch([POST]);
    vi.stubGlobal("fetch", fn);

    const res = await callApifyTool(TENANT, "scrape_reddit", {
      mode: "subreddit",
      subreddit: "SaaS",
    });
    const out = JSON.parse(res.content) as {
      window: string;
      posts: Record<string, unknown>[];
    };
    const p = out.posts[0];

    expect(p.score).toBe(7);
    expect(p.upvote_ratio).toBe(0.86);
    expect(p.subscribers).toBe(2533520);
    expect(p.age_hours).toBe(5.9);
    expect(p.locked).toBe(false);
    expect((p.body as string).length).toBe(1200);
    expect(p.bodyHtml).toBeUndefined();
    expect(p.mediaMetadata).toBeUndefined();
    expect(out.window).toBe("top posts, past year");
  });

  it("requires a query for the two search modes", async () => {
    const { fn, seen } = captureFetch([POST]);
    vi.stubGlobal("fetch", fn);

    for (const mode of ["communities", "search_posts"]) {
      const res = await callApifyTool(TENANT, "scrape_reddit", { mode });
      expect(res.is_error, mode).toBe(true);
    }
    expect(seen).toHaveLength(0);
  });
});
