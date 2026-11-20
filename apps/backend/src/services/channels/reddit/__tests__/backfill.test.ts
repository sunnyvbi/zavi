import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const file = path.join(os.tmpdir(), `reddit-backfill-store-${process.pid}.json`);
process.env.REDDIT_LOCAL_STORE_FILE = file;
process.env.REDDIT_LOCAL_STORE = "1";
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ from: vi.fn(), rpc: vi.fn() }) }));

let redditDb: typeof import("../db").redditDb;
let backfillTermMentions: typeof import("../sweep").backfillTermMentions;

describe("backfillTermMentions", () => {
  beforeAll(async () => {
    ({ redditDb } = await import("../db"));
    ({ backfillTermMentions } = await import("../sweep"));
  }, 60_000);
  afterAll(() => {
    delete process.env.REDDIT_LOCAL_STORE;
    fs.rmSync(file, { force: true });
  });

  it("records mentions for a newly tracked competitor from stored threads and comments, once", async () => {
    const db = redditDb();
    const now = new Date("2026-09-18T10:00:00Z");
    const seen = "2026-09-17T10:00:00Z";
    const old = "2026-09-01T10:00:00Z";

    const hit = await db
      .from("reddit_threads")
      .insert({ tenant_id: "t", url: "https://www.reddit.com/r/turo/comments/a1/", subreddit: "turo", title: "What are your experiences with Turo?", posted_at: seen, last_seen_at: seen, sentiment: "negative" })
      .select("id")
      .single();
    const miss = await db
      .from("reddit_threads")
      .insert({ tenant_id: "t", url: "https://www.reddit.com/r/cars/comments/b2/", subreddit: "cars", title: "Neuturo is a word I made up", posted_at: seen, last_seen_at: seen })
      .select("id")
      .single();
    await db
      .from("reddit_threads")
      .insert({ tenant_id: "t", url: "https://www.reddit.com/r/turo/comments/c3/", subreddit: "turo", title: "Turo from long ago", posted_at: old, last_seen_at: old });
    await db.from("reddit_threads").insert({ tenant_id: "other", url: "https://www.reddit.com/r/turo/comments/d4/", subreddit: "turo", title: "Turo elsewhere", last_seen_at: seen });
    const missId = (miss.data as { id: string }).id;
    await db.from("reddit_comments").insert({ tenant_id: "t", thread_id: missId, content_hash: "h1", body_excerpt: "I left turo last year", sentiment: "positive", first_seen_at: seen });

    const term = { term: "Turo", kind: "competitor" as const, keyword_id: null, competitor_id: "comp-1" };
    expect(await backfillTermMentions(db, "t", term, now)).toBe(2);
    expect(await backfillTermMentions(db, "t", term, now)).toBe(0);

    const { data } = await db.from("reddit_mentions").select("thread_id, comment_id, kind, competitor_id, sentiment, subreddit").eq("tenant_id", "t");
    const rows = data as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.comment_id === null)).toMatchObject({
      thread_id: (hit.data as { id: string }).id,
      kind: "competitor",
      competitor_id: "comp-1",
      sentiment: "negative",
      subreddit: "turo",
    });
    expect(rows.find((r) => r.comment_id !== null)).toMatchObject({ thread_id: missId, sentiment: "positive", subreddit: "cars" });
  });
});
