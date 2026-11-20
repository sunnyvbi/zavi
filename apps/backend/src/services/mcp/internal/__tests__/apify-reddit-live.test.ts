
import { describe, it, expect } from "vitest";
import { callApifyTool } from "../apify";

const LIVE = process.env.APIFY_E2E === "1";
const TENANT = "00000000-0000-0000-0000-000000000000";

describe.skipIf(!LIVE)("scrape_reddit — LIVE", () => {
  it("reads a real subreddit with the fields the recipe depends on", async () => {
    const res = await callApifyTool(TENANT, "scrape_reddit", {
      mode: "subreddit",
      subreddit: "smallbusiness",
      time: "month",
      max_items: 5,
    });
    expect(res.is_error, res.content).toBe(false);
    const out = JSON.parse(res.content) as { posts: Record<string, unknown>[] };
    expect(out.posts.length).toBeGreaterThan(0);

    const p = out.posts[0];
    expect(typeof p.score).toBe("number");
    expect(typeof p.upvote_ratio).toBe("number");
    expect(typeof p.subscribers).toBe("number");
    expect(p.subscribers as number).toBeGreaterThan(1_000_000);
    expect(typeof p.title).toBe("string");
  }, 300_000);

  it("returns community sidebar descriptions, which is where posted rules live", async () => {
    const res = await callApifyTool(TENANT, "scrape_reddit", {
      mode: "communities",
      query: "cold email deliverability",
      max_items: 5,
    });
    expect(res.is_error, res.content).toBe(false);
    const out = JSON.parse(res.content) as { communities: { name: string; description: string }[] };
    expect(out.communities.length).toBeGreaterThan(0);
    expect(Math.max(...out.communities.map((c) => c.description.length))).toBeGreaterThan(300);
  }, 300_000);

  it("relevance sort actually honours the query", async () => {
    const res = await callApifyTool(TENANT, "scrape_reddit", {
      mode: "search_posts",
      query: "cold email deliverability",
      max_items: 6,
    });
    expect(res.is_error, res.content).toBe(false);
    const out = JSON.parse(res.content) as { posts: { title: string; community: string }[] };
    const onTopic = out.posts.filter((p) =>
      /email|cold|outreach|deliverab|spam|inbox/i.test(`${p.title} ${p.community}`),
    );
    expect(onTopic.length).toBeGreaterThanOrEqual(Math.ceil(out.posts.length / 2));
  }, 300_000);
});
