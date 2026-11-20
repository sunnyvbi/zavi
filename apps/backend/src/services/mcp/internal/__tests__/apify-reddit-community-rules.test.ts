
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

function community(name: string, description: string) {
  return {
    dataType: "community",
    name,
    title: name,
    subscribers: null,
    description,
  };
}

const WEBDEV_RULES =
  "# Posting Guidelines\n1. No blogspam or self-promotion.\n2. Read the wiki before asking.";

describe("scrape_reddit mode='community_rules'", () => {
  beforeEach(() => {
    process.env.APIFY_TOKEN = "test-token";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.APIFY_TOKEN;
  });

  it("reads the rules list when the actor leaves the sidebar description empty", async () => {
    const record = {
      dataType: "community",
      name: "smallbusiness",
      title: "smallbusiness",
      description: null,
      publicDescription: "Questions about starting, owning and growing a small business.",
      rules: [
        { shortName: "Post only questions about small business.", description: "This is a question and answer subreddit.", kind: "all" },
        { shortName: "No self-promotion", description: "No links to your own business or product.", kind: "all" },
      ],
    };
    const { fn } = captureFetch([community("smallbusinessowner", ""), record]);
    vi.stubGlobal("fetch", fn);
    const res = await callApifyTool(TENANT, "scrape_reddit", { mode: "community_rules", subreddit: "smallbusiness" });
    expect(res.ok).toBe(true);
    const out = JSON.parse(res.content) as { subreddit: string; rules_text: string; rules_text_present: boolean };
    expect(out.subreddit).toBe("smallbusiness");
    expect(out.rules_text_present).toBe(true);
    expect(out.rules_text).toContain("Questions about starting, owning and growing a small business.");
    expect(out.rules_text).toContain("1. Post only questions about small business.\nThis is a question and answer subreddit.");
    expect(out.rules_text).toContain("2. No self-promotion\nNo links to your own business or product.");
  });

  it("keeps the sidebar text when the actor still sends one, even with a rules list beside it", async () => {
    const record = { ...community("webdev", WEBDEV_RULES), rules: [{ shortName: "Other", description: "x" }] };
    const { fn } = captureFetch([record]);
    vi.stubGlobal("fetch", fn);
    const res = await callApifyTool(TENANT, "scrape_reddit", { mode: "community_rules", subreddit: "webdev" });
    expect((JSON.parse(res.content) as { rules_text: string }).rules_text).toBe(WEBDEV_RULES);
  });

  it("runs the communities job shape on the bare name and returns the exact match's rules", async () => {
    const { fn, seen } = captureFetch([community("webdev", WEBDEV_RULES)]);
    vi.stubGlobal("fetch", fn);

    const res = await callApifyTool(TENANT, "scrape_reddit", {
      mode: "community_rules",
      subreddit: "webdev",
    });

    expect(res.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].body.searchTerms).toEqual(["webdev"]);
    expect(seen[0].body.searchCommunities).toBe(true);
    expect(seen[0].body.searchPosts).toBe(false);
    expect(seen[0].body.searchSort).toBe("relevance");
    expect(seen[0].body.maxPostsCount).toBe(0);
    expect(seen[0].body.maxCommunitiesCount).toBe(10);
    expect(seen[0].body.includeNSFW).toBe(true);
    expect(seen[0].body.fastMode).toBe(false);

    const out = JSON.parse(res.content) as {
      mode: string;
      subreddit: string;
      rules_text: string;
      rules_text_present: boolean;
      source: string;
      matched: boolean;
    };
    expect(out.mode).toBe("community_rules");
    expect(out.subreddit).toBe("webdev");
    expect(out.rules_text).toBe(WEBDEV_RULES);
    expect(out.rules_text_present).toBe(true);
    expect(out.source).toBe("sidebar_description");
    expect(out.matched).toBe(true);
  });

  it("raises reddit_community_unresolved on near-matches and names them", async () => {
    const { fn } = captureFetch([
      community("Web_Development", "Rules: no promotion of any kind, ever."),
      community("webdevelopment", "Rules: flair your post."),
    ]);
    vi.stubGlobal("fetch", fn);

    const res = await callApifyTool(TENANT, "scrape_reddit", {
      mode: "community_rules",
      subreddit: "webdev",
    });

    expect(res.ok).toBe(false);
    expect(res.is_error).toBe(true);
    expect(res.content).toContain("reddit_community_unresolved");
    expect(res.content).toContain("Web_Development");
    expect(res.content).toContain("webdevelopment");
    expect(res.content).toContain("UNREAD");
    expect(res.content).not.toContain("no promotion of any kind");
  });

  it("raises reddit_community_unresolved when the search returns nothing at all", async () => {
    const { fn } = captureFetch([]);
    vi.stubGlobal("fetch", fn);

    const res = await callApifyTool(TENANT, "scrape_reddit", {
      mode: "community_rules",
      subreddit: "thissubdoesnotexist",
    });

    expect(res.ok).toBe(false);
    expect(res.content).toContain("reddit_community_unresolved");
    expect(res.content).toContain("UNREAD");
  });

  it("matches case-insensitively — 'WebDev' asked, 'webdev' returned", async () => {
    const { fn } = captureFetch([community("webdev", WEBDEV_RULES)]);
    vi.stubGlobal("fetch", fn);

    const res = await callApifyTool(TENANT, "scrape_reddit", {
      mode: "community_rules",
      subreddit: "WebDev",
    });

    expect(res.ok).toBe(true);
    const out = JSON.parse(res.content) as { subreddit: string; rules_text: string };
    expect(out.subreddit).toBe("webdev");
    expect(out.rules_text).toBe(WEBDEV_RULES);
  });

  it("returns the matched community's rules, never a sibling's", async () => {
    const SIBLING = "Rules: this is r/webdevelopment, self-promo is fine here.";
    const { fn } = captureFetch([
      community("webdevelopment", SIBLING),
      community("webdev", WEBDEV_RULES),
    ]);
    vi.stubGlobal("fetch", fn);

    const res = await callApifyTool(TENANT, "scrape_reddit", {
      mode: "community_rules",
      subreddit: "webdev",
    });

    expect(res.ok).toBe(true);
    const out = JSON.parse(res.content) as { subreddit: string; rules_text: string };
    expect(out.subreddit).toBe("webdev");
    expect(out.rules_text).toBe(WEBDEV_RULES);
    expect(out.rules_text).not.toContain("self-promo is fine");
    expect(res.content).not.toContain(SIBLING);
  });

  it("reports an empty sidebar as rules_text_present:false, not as a throw", async () => {
    const { fn } = captureFetch([community("webdev", "")]);
    vi.stubGlobal("fetch", fn);

    const res = await callApifyTool(TENANT, "scrape_reddit", {
      mode: "community_rules",
      subreddit: "webdev",
    });

    expect(res.ok).toBe(true);
    const out = JSON.parse(res.content) as {
      matched: boolean;
      rules_text: string;
      rules_text_present: boolean;
    };
    expect(out.matched).toBe(true);
    expect(out.rules_text).toBe("");
    expect(out.rules_text_present).toBe(false);
  });

  it("refuses a subreddit that is a path or a URL, not a bare name", async () => {
    const { fn, seen } = captureFetch([community("webdev", WEBDEV_RULES)]);
    vi.stubGlobal("fetch", fn);

    for (const bad of ["r/webdev", "https://reddit.com/r/webdev", "web/../../x", "a b"]) {
      const res = await callApifyTool(TENANT, "scrape_reddit", {
        mode: "community_rules",
        subreddit: bad,
      });
      expect(res.is_error, bad).toBe(true);
    }
    expect(seen).toHaveLength(0);
  });

  it("needs a subreddit — a query is not a name", async () => {
    const { fn, seen } = captureFetch([community("webdev", WEBDEV_RULES)]);
    vi.stubGlobal("fetch", fn);

    const res = await callApifyTool(TENANT, "scrape_reddit", {
      mode: "community_rules",
      query: "web development rules",
    });

    expect(res.is_error).toBe(true);
    expect(seen).toHaveLength(0);
  });
});

describe("scrape_reddit — the three pre-existing modes are unchanged", () => {
  beforeEach(() => {
    process.env.APIFY_TOKEN = "test-token";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.APIFY_TOKEN;
  });

  it("communities still asks for communities only, at the caller's max_items", async () => {
    const { fn, seen } = captureFetch([community("ColdEmailAndSales", "1. Share what you learned.")]);
    vi.stubGlobal("fetch", fn);

    const res = await callApifyTool(TENANT, "scrape_reddit", {
      mode: "communities",
      query: "cold email",
      max_items: 5,
    });

    expect(res.ok).toBe(true);
    expect(seen[0].body.searchTerms).toEqual(["cold email"]);
    expect(seen[0].body.searchCommunities).toBe(true);
    expect(seen[0].body.searchPosts).toBe(false);
    expect(seen[0].body.searchSort).toBe("relevance");
    expect(seen[0].body.maxCommunitiesCount).toBe(5);
    expect(seen[0].body.maxPostsCount).toBe(0);
    const out = JSON.parse(res.content) as { mode: string; communities: unknown[] };
    expect(out.mode).toBe("communities");
    expect(out.communities).toHaveLength(1);
  });

  it("search_posts still searches posts at pinned relevance", async () => {
    const { fn, seen } = captureFetch([
      { dataType: "post", title: "t", postUrl: "https://www.reddit.com/r/SaaS/comments/a/" },
    ]);
    vi.stubGlobal("fetch", fn);

    const res = await callApifyTool(TENANT, "scrape_reddit", {
      mode: "search_posts",
      query: "cold email deliverability",
      max_items: 7,
    });

    expect(res.ok).toBe(true);
    expect(seen[0].body.searchPosts).toBe(true);
    expect(seen[0].body.searchCommunities).toBe(false);
    expect(seen[0].body.searchSort).toBe("relevance");
    expect(seen[0].body.maxPostsCount).toBe(7);
    expect(seen[0].body.maxCommunitiesCount).toBe(0);
  });

  it("subreddit still reads top posts through a start URL", async () => {
    const { fn, seen } = captureFetch([
      { dataType: "post", title: "t", postUrl: "https://www.reddit.com/r/smallbusiness/comments/a/" },
    ]);
    vi.stubGlobal("fetch", fn);

    const res = await callApifyTool(TENANT, "scrape_reddit", {
      mode: "subreddit",
      subreddit: "smallbusiness",
      time: "month",
      max_items: 5,
    });

    expect(res.ok).toBe(true);
    expect(seen[0].body.startUrls).toEqual([
      { url: "https://www.reddit.com/r/smallbusiness/top/?t=month" },
    ]);
    expect(seen[0].body.maxPostsCount).toBe(5);
    expect(seen[0].body.searchCommunities).toBeUndefined();
    const out = JSON.parse(res.content) as { window: string };
    expect(out.window).toBe("top posts, past month");
  });
});
