import { describe, expect, it, vi } from "vitest";
import { LINKEDIN_METER_KEY, LINKEDIN_READS_PER_DAY, readLinkedInPage, refreshLinkedIn, savedPageUrl } from "../snapshots";
import { shapeLinkedIn } from "@/routes/agents/dashboards/linkedin-organic";
import type { LinkedInPublicPage } from "../public-page";

const URL = "https://www.linkedin.com/company/acme/";
const page = (over: Partial<LinkedInPublicPage> = {}): LinkedInPublicPage => ({
  kind: "company", name: "Acme", followers: 100, about: null, photo_url: null, banner_url: null, location: null, website: null,
  posts: [{ id: "p1", url: "https://www.linkedin.com/posts/p1", text: "hello", posted_at: "2026-09-01T00:00:00Z", format: "post", reactions: 5, comments: 1, reposts: 2 }],
  ...over,
});
const ctx = async () => ({ channel_settings: { profile_url: [{ item: URL }] } });

function harness(rpcData: number | null, rpcError: unknown = null) {
  const upserts: Array<{ table: string; rows: unknown }> = [];
  const client = { from: (table: string) => ({ upsert: async (rows: unknown) => (upserts.push({ table, rows }), { error: null }) }) };
  const rpc = vi.fn(async () => ({ data: rpcData, error: rpcError }));
  return { upserts, client: client as never, rpc: rpc as never, rpcSpy: rpc };
}

describe("refreshLinkedIn", () => {
  it("reserves a slot under LinkedIn's own key and cap, then stores the account and its posts", async () => {
    const h = harness(1);
    const r = await refreshLinkedIn("t1", { context: ctx, rpc: h.rpc, client: h.client, fetchViaApify: async () => page() });
    expect(r).toEqual({ ok: true, posts: 1, used: 1, cap: LINKEDIN_READS_PER_DAY });
    expect(h.rpcSpy.mock.calls[0].slice(1)).toEqual(["consume_metered_read_or_reject", expect.objectContaining({ p_key: LINKEDIN_METER_KEY, p_cap: 3 })]);
    expect(h.upserts.map((u) => u.table)).toEqual(["social_post_metric_snapshots", "social_account_snapshots", "tenant_app_setting"]);
    expect((h.upserts[0].rows as Array<{ metrics: unknown; channel: string }>)[0]).toMatchObject({ channel: "linkedin", metrics: { reactions: 5, comments: 1, reposts: 2 } });
  });

  it("at the cap: no vendor read, nothing written", async () => {
    const h = harness(null);
    const apify = vi.fn();
    const r = await refreshLinkedIn("t1", { context: ctx, rpc: h.rpc, client: h.client, fetchViaApify: apify, fetchPage: apify });
    expect(r).toMatchObject({ ok: false, reason: "cap_reached" });
    expect(apify).not.toHaveBeenCalled();
    expect(h.upserts).toEqual([]);
  });

  it("an unreadable counter fails closed: no vendor read", async () => {
    const h = harness(null, { message: "boom" });
    const apify = vi.fn();
    const r = await refreshLinkedIn("t1", { context: ctx, rpc: h.rpc, client: h.client, fetchViaApify: apify, fetchPage: apify });
    expect(r).toMatchObject({ ok: false, reason: "unavailable" });
    expect(apify).not.toHaveBeenCalled();
  });

  it("no saved page spends no slot", async () => {
    const h = harness(1);
    const r = await refreshLinkedIn("t1", { context: async () => ({}), rpc: h.rpc, client: h.client });
    expect(r).toMatchObject({ ok: false, reason: "no_page" });
    expect(h.rpcSpy).not.toHaveBeenCalled();
  });

  it("a failed read keeps its slot: consume is called once and never released", async () => {
    const h = harness(2);
    const boom = async () => { throw new Error("down"); };
    const r = await refreshLinkedIn("t1", { context: ctx, rpc: h.rpc, client: h.client, fetchViaApify: boom, fetchPage: boom });
    expect(r).toMatchObject({ ok: false, reason: "read_failed" });
    expect(h.rpcSpy).toHaveBeenCalledTimes(1);
  });
});

describe("readLinkedInPage", () => {
  it("falls back to our own read when Apify fails", async () => {
    const own = page({ name: "Own" });
    expect(await readLinkedInPage(URL, { fetchViaApify: async () => { throw new Error("x"); }, fetchPage: async () => own })).toBe(own);
  });
  it("a member's followers come from our own read when Apify has none", async () => {
    const got = await readLinkedInPage(URL, { fetchViaApify: async () => page({ followers: null }), fetchPage: async () => page({ followers: 777, posts: [] }) });
    expect(got.followers).toBe(777);
    expect(got.posts).toHaveLength(1);
  });
});

it("savedPageUrl canonicalizes the saved item and ignores junk", () => {
  expect(savedPageUrl({ channel_settings: { profile_url: [{ item: "nope" }, { item: "linkedin.com/company/acme" }] } })).toBe(URL);
  expect(savedPageUrl(null)).toBeNull();
});

describe("shapeLinkedIn", () => {
  const post = (id: string, day: string, reactions: number, reposts: number | null = 0) => ({ external_post_id: id, captured_on: day, posted_at: null, text: id, url: null, metrics: { reactions, comments: 1, reposts } });
  const NOW = new Date("2026-09-22T00:00:00Z");

  it("uses each post's NEWEST row, ranks the table by engagement, and compares followers to the window's first day", () => {
    const out = shapeLinkedIn(
      [{ captured_on: "2026-09-01", name: "Acme", followers_count: 90 }, { captured_on: "2026-09-21", name: "Acme", followers_count: 100 }],
      [post("a", "2026-09-01", 1), post("a", "2026-09-21", 9), post("b", "2026-09-21", 20, null)],
      NOW,
    );
    expect(out.top_posts.map((p) => [p.id, p.reactions])).toEqual([["b", 20], ["a", 9]]);
    const m = Object.fromEntries(out.metrics.map((x) => [x.key, x]));
    expect(m.followers).toMatchObject({ value: 100, prev_value: 90, prev_day: "2026-09-01" });
    expect(m.total_posts.value).toBe(2);
  });

  it("the seven keys, and no others", () => {
    const out = shapeLinkedIn(
      [{ captured_on: "2026-09-21", name: "A", followers_count: 1000 }],
      [{ ...post("a", "2026-09-21", 10), posted_at: "2026-09-20T00:00:00Z" }],
      NOW,
    );
    expect(out.metrics.map((m) => m.key)).toEqual(["followers", "total_posts", "engagement_rate", "reactions", "comments", "reposts", "days_since_last_post"]);
  });

  it("reactions, comments and reposts are totals only when every collected post states them", () => {
    const counted = shapeLinkedIn(
      [{ captured_on: "2026-09-21", name: "A", followers_count: 100 }],
      [post("a", "2026-09-21", 9, 2), post("b", "2026-09-21", 4, 0)],
      NOW,
    );
    const m = Object.fromEntries(counted.metrics.map((x) => [x.key, x.value]));
    expect([m.reactions, m.comments, m.reposts]).toEqual([13, 2, 2]);
    const unknown = shapeLinkedIn([{ captured_on: "2026-09-21", name: "A", followers_count: 100 }], [post("a", "2026-09-21", 9, null)], NOW);
    expect(unknown.metrics.map((x) => x.key)).not.toContain("reposts");
  });

  it("engagement rate is per post over followers, and carries the percent unit", () => {
    const out = shapeLinkedIn(
      [{ captured_on: "2026-09-21", name: "Upcar", followers_count: 10840 }],
      [{ external_post_id: "p", captured_on: "2026-09-21", posted_at: "2026-08-28T17:45:03Z", text: "t", url: null, metrics: { reactions: 12, comments: 1, reposts: 2 } }],
      NOW,
    );
    const m = Object.fromEntries(out.metrics.map((x) => [x.key, x]));
    expect(m.engagement_rate).toMatchObject({ value: 0.14, unit: "pct" });
    expect(m.days_since_last_post.value).toBe(24);
  });

  it("a missing repost count counts as zero engagements, never as a missing post", () => {
    const out = shapeLinkedIn(
      [{ captured_on: "2026-09-21", name: "A", followers_count: 100 }],
      [{ ...post("a", "2026-09-21", 9, null), posted_at: "2026-09-21T00:00:00Z" }],
      NOW,
    );
    const m = Object.fromEntries(out.metrics.map((x) => [x.key, x]));
    expect(m.engagement_rate.value).toBe(10);
    expect(m.total_posts.value).toBe(1);
  });

  it("no followers, or no posts: the rate is absent rather than 0%", () => {
    const noFollowers = shapeLinkedIn([{ captured_on: "2026-09-21", name: "A", followers_count: null }], [{ ...post("a", "2026-09-21", 5), posted_at: "2026-09-21T00:00:00Z" }], NOW);
    expect(noFollowers.metrics.some((m) => m.key === "engagement_rate")).toBe(false);
    const noPosts = shapeLinkedIn([{ captured_on: "2026-09-21", name: "A", followers_count: 500 }], [], NOW);
    expect(noPosts.metrics.map((m) => m.key)).toEqual(["followers"]);
  });

  it("the table is the 5 most engaged, newest first; the numbers use all of them", () => {
    const rows = [1, 2, 3, 4, 5, 6].map((n) => ({ ...post(`p${n}`, "2026-09-21", n * 10), posted_at: `2026-09-0${7 - n}T00:00:00Z` }));
    const out = shapeLinkedIn([{ captured_on: "2026-09-21", name: "A", followers_count: 1000 }], rows, NOW);
    expect(out.top_posts.map((p) => p.id)).toEqual(["p2", "p3", "p4", "p5", "p6"]);
    expect(out.metrics.find((m) => m.key === "total_posts")?.value).toBe(6);
  });

  it("nothing stored: no numbers at all, rather than zeroes", () => {
    expect(shapeLinkedIn([], [])).toMatchObject({ account: null, metrics: [], top_posts: [] });
  });
});

it("automatic reads atomically reserve only the first daily slot, leaving manual retries", async () => {
  let reads = 0;
  const rpc = vi.fn(async (_tenant: unknown, _name: unknown, args: {p_cap: number}) => ({data: reads < args.p_cap ? ++reads : null, error: null}));
  const h = harness(1); const apify = vi.fn(async () => page());
  const deps = { context: ctx, rpc: rpc as never, client: h.client, fetchViaApify: apify, automatic: true };
  const results = await Promise.all([refreshLinkedIn("t1", deps), refreshLinkedIn("t1", deps)]);
  expect(results.filter(r => r.ok)).toHaveLength(1); expect(apify).toHaveBeenCalledTimes(1);
  expect(await refreshLinkedIn("t1", {...deps, automatic:false})).toMatchObject({ok:true,used:2});
  expect(reads).toBe(2);
});
it("keeps the failure receipt without exposing provider or database error text", async () => {
  const h = harness(1);
  const fail = async () => {throw new Error("internal vendor diagnostic")};
  await refreshLinkedIn("t1", {context:ctx,rpc:h.rpc,client:h.client,fetchViaApify:fail,fetchPage:fail});
  const receipt = h.upserts.find(x => x.table === "tenant_app_setting");
  expect(receipt?.rows).toMatchObject({value:{page_url:URL,ok:false,message:expect.stringContaining("could not be read")}});
  expect(JSON.stringify(receipt)).not.toContain("internal vendor diagnostic");
});
it("does not call a partial repost subtotal the total", () => {
  const rows = [
    {external_post_id:"one",captured_on:"2026-11-01",posted_at:null,text:"one",url:null,metrics:{reactions:3,comments:1,reposts:2}},
    {external_post_id:"two",captured_on:"2026-11-01",posted_at:null,text:"two",url:null,metrics:{reactions:2,comments:1,reposts:null}},
  ];
  expect(shapeLinkedIn([],rows).metrics.map(m=>m.key)).not.toContain("reposts");
});

 it("does not mark a read successful when post snapshots cannot be saved", async () => {
   const h = harness(1);
   const tables: string[] = [];
   const client = {from: (table: string) => ({upsert: async () => {tables.push(table); return {error: table === "social_post_metric_snapshots" ? {message: "storage failure"} : null};}})} as any;
   const result = await refreshLinkedIn("t1", {context:ctx,rpc:h.rpc,client,fetchViaApify:async()=>page()});
   expect(result).toMatchObject({ok:false,reason:"unavailable"});
   expect(tables).toEqual(["social_post_metric_snapshots", "tenant_app_setting"]);
 });
