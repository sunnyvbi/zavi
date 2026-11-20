import { describe, expect, it, vi } from "vitest";

const refreshTikTok = vi.fn();
vi.mock("@/services/tiktok-social/snapshots", () => ({
  TIKTOK_CHANNEL: "tiktok",
  TIKTOK_METER_KEY: "tiktok_metrics",
  TIKTOK_READS_PER_DAY: 3,
  refreshTikTok: (...a: unknown[]) => refreshTikTok(...a),
}));
vi.mock("@/services/channels/staged-drafts", () => ({
  TIKTOK_CHANNELS: new Set(["tiktok_video"]),
  stagedDrafts: async () => [],
}));

import { build, shapeTikTok } from "../tiktok-organic";

const acct = (captured_on: string, followers_count: number | null, post_count: number | null = 42) => ({
  captured_on,
  username: null,
  name: "Zavi",
  followers_count,
  post_count,
});

const post = (
  id: string,
  captured_on: string,
  metrics: Record<string, number | null> | null,
  posted_at = "2026-09-20T10:00:00.000Z",
) => ({
  external_post_id: id,
  captured_on,
  posted_at,
  text: `video ${id}`,
  url: `https://www.tiktok.com/@zavi/video/${id}`,
  format: "VIDEO",
  metrics,
});

describe("shapeTikTok", () => {
  it("sums the newest read of each video and derives the rate over views", () => {
    const out = shapeTikTok(
      [acct("2026-09-01", 900), acct("2026-09-29", 1000)],
      [
        post("v1", "2026-09-20", { views: 10, likes: 1, comments: 0, shares: 0 }),
        post("v1", "2026-09-29", { views: 100, likes: 10, comments: 4, shares: 6 }),
        post("v2", "2026-09-29", { views: 300, likes: 30, comments: 6, shares: 4 }),
      ],
    );
    const m = Object.fromEntries(out.metrics.map((r) => [r.key, r]));
    expect(m.followers.value).toBe(1000);
    expect(m.followers.prev_value).toBe(900);
    expect(m.total_posts.value).toBe(42);
    expect(m.views.value).toBe(400);
    expect(m.likes.value).toBe(40);
    expect(m.comments.value).toBe(10);
    expect(m.shares.value).toBe(10);
    expect(m.engagement_rate.value).toBe(15);
    expect(out.top_posts.map((p) => p.id).sort()).toEqual(["v1", "v2"]);
    expect(out.account).toEqual({ username: null, name: "Zavi", followers: 1000 });
  });

  it("answers null, not zero, for numbers no video carries", () => {
    const out = shapeTikTok(
      [acct("2026-09-29", 500)],
      [post("v1", "2026-09-29", { views: null, likes: 3, comments: 1, shares: null })],
    );
    const keys = out.metrics.map((r) => r.key);
    expect(keys).not.toContain("views");
    expect(keys).not.toContain("engagement_rate");
    const m = Object.fromEntries(out.metrics.map((r) => [r.key, r]));
    expect(m.likes.value).toBe(3);
    expect(m.comments.value).toBe(1);
  });

  it("keeps a like/comment count TikTok did not give as null, never 0", () => {
    const out = shapeTikTok(
      [acct("2026-09-29", 500, null)],
      [post("v1", "2026-09-29", { views: 50, likes: null, comments: null, shares: null })],
    );
    const keys = out.metrics.map((r) => r.key);
    expect(keys).not.toContain("likes");
    expect(keys).not.toContain("comments");
    expect(keys).not.toContain("engagement_rate");
    expect(keys).not.toContain("total_posts");
    expect(out.top_posts[0].likes).toBeNull();
    expect(out.top_posts[0].comments).toBeNull();
  });

  it("degrades to just nothing on no rows", () => {
    const out = shapeTikTok([], []);
    expect(out.metrics).toEqual([]);
    expect(out.top_posts).toEqual([]);
    expect(out.account).toBeNull();
  });
});

function fakeSb(result: (table: string) => { data: unknown; error: unknown }) {
  return {
    from(table: string) {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "gte", "order"]) q[m] = () => q;
      q.maybeSingle = async () => result(table);
      q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result(table)).then(res, rej);
      return q;
    },
  };
}

describe("tiktok_organic build", () => {
  it("a failed stored read says so and spends no metered refresh", async () => {
    refreshTikTok.mockReset();
    const sb = fakeSb((t) =>
      t === "connector_metadata"
        ? { data: [{ slug: "tiktok" }], error: null }
        : t === "social_account_snapshots"
          ? { data: null, error: { message: "boom" } }
          : { data: [], error: null },
    );
    const out = (await build({ sb, tenantId: "t1" } as never)) as { problem: string | null; metrics: unknown[] };
    expect(refreshTikTok).not.toHaveBeenCalled();
    expect(out.problem).toMatch(/could not load your stored TikTok numbers/);
    expect(out.metrics).toEqual([]);
  });

  it("a connected row the reader cannot use is reported, not an empty page", async () => {
    refreshTikTok.mockReset();
    refreshTikTok.mockResolvedValue({ ok: false, reason: "not_connected", message: "Connect TikTok in Settings first." });
    const sb = fakeSb((t) =>
      t === "connector_metadata" ? { data: [{ slug: "tiktok" }], error: null } : { data: [], error: null },
    );
    const out = (await build({ sb, tenantId: "t1" } as never)) as { problem: string | null };
    expect(refreshTikTok).toHaveBeenCalledTimes(1);
    expect(out.problem).toBe("Connect TikTok in Settings first.");
  });
});
