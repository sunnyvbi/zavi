import { afterEach, describe, expect, it, vi } from "vitest";

const refreshInstagram = vi.fn();
vi.mock("@/services/instagram-social/snapshots", () => ({
  INSTAGRAM_CHANNEL: "instagram",
  INSTAGRAM_METER_KEY: "instagram_metrics",
  INSTAGRAM_READS_PER_DAY: 3,
  refreshInstagram: (...a: unknown[]) => refreshInstagram(...a),
}));
vi.mock("@/services/channels/staged-drafts", () => ({
  INSTAGRAM_CHANNELS: new Set(["instagram_image"]),
  stagedDrafts: async () => [],
}));

import { build, shapeInstagram } from "../instagram-organic";

const acct = (captured_on: string, followers_count: number | null, post_count: number | null = 120) => ({
  captured_on,
  username: "zoomcar",
  name: "Zoomcar",
  followers_count,
  post_count,
});

const post = (
  id: string,
  captured_on: string,
  metrics: Record<string, number | null> | null,
  posted_at = "2026-09-20T10:00:00+0000",
) => ({
  external_post_id: id,
  captured_on,
  posted_at,
  text: `post ${id}`,
  url: `https://instagram.com/p/${id}/`,
  format: "FEED",
  metrics,
});

describe("shapeInstagram", () => {
  it("shows only the account read last after a reconnect to another login", () => {
    const as = (captured_on: string, username: string, followers_count: number, post_count: number) =>
      ({ captured_on, username, name: username, followers_count, post_count });
    const out = shapeInstagram(
      [as("2026-10-01", "testxup", 7, 0), as("2026-10-02", "testxup", 7, 1), as("2026-10-09", "amogh_zavi", 0, 1), as("2026-10-19", "amogh_zavi", 0, 1)],
      [
        post("zavi_test", "2026-10-02", { views: 0, reach: 0, likes: 0, comments: 0, saved: 0, total_interactions: 0 }),
        post("test_img", "2026-10-19", { views: 2, reach: 2, likes: 0, comments: 0, saved: 0, total_interactions: 0 }),
      ],
    );
    expect(out.top_posts.map((p) => p.id)).toEqual(["test_img"]);
    const m = Object.fromEntries(out.metrics.map((r) => [r.key, r]));
    expect(m.total_posts.value).toBe(1);
    expect(m.followers.prev_value).toBe(0);
    expect(out.account?.username).toBe("amogh_zavi");
  });

  it("sums the newest read of each post and derives the rate over reach", () => {
    const out = shapeInstagram(
      [acct("2026-09-01", 900), acct("2026-09-29", 1000)],
      [
        post("p1", "2026-09-20", { views: 10, reach: 8, likes: 1, comments: 0, saved: 0, total_interactions: 1 }),
        post("p1", "2026-09-29", { views: 100, reach: 80, likes: 10, comments: 4, saved: 6, total_interactions: 20 }),
        post("p2", "2026-09-29", { views: 300, reach: 120, likes: 30, comments: 6, saved: 4, total_interactions: 40 }),
      ],
    );
    const m = Object.fromEntries(out.metrics.map((r) => [r.key, r]));
    expect(m.followers.value).toBe(1000);
    expect(m.followers.prev_value).toBe(900);
    expect(m.total_posts.value).toBe(120);
    expect(m.views.value).toBe(400);
    expect(m.reach.value).toBe(200);
    expect(m.likes.value).toBe(40);
    expect(m.comments.value).toBe(10);
    expect(m.saves.value).toBe(10);
    expect(m.engagement_rate.value).toBe(30);
    expect(out.top_posts.map((p) => p.id).sort()).toEqual(["p1", "p2"]);
    expect(out.account).toEqual({ username: "zoomcar", name: "Zoomcar", followers: 1000 });
  });

  it("uses matching posts for both sides of the engagement rate", () => {
    const out = shapeInstagram([acct("2026-09-29", 500)], [
      post("complete", "2026-09-29", { reach: 100, total_interactions: 10 }),
      post("interactions_only", "2026-09-29", { total_interactions: 20 }),
      post("views_only", "2026-09-29", { views: 100, likes: 50, comments: 5 }),
      post("reach_only", "2026-09-29", { reach: 900 }),
    ]);
    const m = Object.fromEntries(out.metrics.map((r) => [r.key, r]));
    expect(m.reach.value).toBe(1000);
    expect(m.engagement_rate.value).toBe(10);
  });

  it("does not derive a rate from disjoint or zero-reach samples", () => {
    for (const rows of [
      [post("reach", "2026-09-29", { reach: 100 }), post("interactions", "2026-09-29", { total_interactions: 10 })],
      [post("zero", "2026-09-29", { reach: 0, total_interactions: 0 })],
    ]) {
      expect(shapeInstagram([acct("2026-09-29", 500)], rows).metrics.map((r) => r.key)).not.toContain("engagement_rate");
    }
  });

  it("retains the public-count fallback only with that post's reach", () => {
    const out = shapeInstagram([acct("2026-09-29", 500)], [
      post("fallback", "2026-09-29", { reach: 100, likes: 5, comments: 3, saved: 2 }),
      post("partial", "2026-09-29", { likes: 100, comments: 100 }),
    ]);
    expect(out.metrics.find((r) => r.key === "engagement_rate")?.value).toBe(10);
  });

  it("answers null, not zero, for numbers no post carries", () => {
    const out = shapeInstagram(
      [acct("2026-09-29", 500)],
      [post("p1", "2026-09-29", { views: null, reach: null, likes: 3, comments: 1, saved: null, total_interactions: null })],
    );
    const keys = out.metrics.map((r) => r.key);
    expect(keys).not.toContain("views");
    expect(keys).not.toContain("reach");
    expect(keys).not.toContain("engagement_rate");
    const m = Object.fromEntries(out.metrics.map((r) => [r.key, r]));
    expect(m.likes.value).toBe(3);
    expect(m.comments.value).toBe(1);
  });

  it("keeps a like/comment count Instagram did not give as null, never 0", () => {
    const out = shapeInstagram(
      [acct("2026-09-29", 500, null)],
      [post("p1", "2026-09-29", { views: 50, reach: 40, likes: null, comments: null, saved: null, total_interactions: null })],
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
    const out = shapeInstagram([], []);
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

describe("instagram_organic build", () => {
  it("a failed stored read says so and spends no metered refresh", async () => {
    refreshInstagram.mockReset();
    const sb = fakeSb((t) =>
      t === "connector_metadata"
        ? { data: [{ slug: "composio.instagram" }], error: null }
        : t === "social_account_snapshots"
          ? { data: null, error: { message: "boom" } }
          : { data: [], error: null },
    );
    const out = (await build({ sb, tenantId: "t1" } as never)) as { problem: string | null; metrics: unknown[] };
    expect(refreshInstagram).not.toHaveBeenCalled();
    expect(out.problem).toMatch(/could not load your stored Instagram numbers/);
    expect(out.metrics).toEqual([]);
  });

  it("a connected row the reader cannot use is reported, not an empty page", async () => {
    refreshInstagram.mockReset();
    refreshInstagram.mockResolvedValue({ ok: false, reason: "not_connected", message: "Connect Instagram in Settings first." });
    const sb = fakeSb((t) =>
      t === "connector_metadata" ? { data: [{ slug: "instagram_social" }], error: null } : { data: [], error: null },
    );
    const out = (await build({ sb, tenantId: "t1" } as never)) as { problem: string | null };
    expect(refreshInstagram).toHaveBeenCalledTimes(1);
    expect(out.problem).toBe("Connect Instagram in Settings first.");
  });

  it("a failed connection lookup says so instead of showing a disconnected, empty page", async () => {
    refreshInstagram.mockReset();
    const sb = fakeSb((t) =>
      t === "connector_metadata" ? { data: null, error: { message: "boom" } } : { data: [], error: null },
    );
    const out = (await build({ sb, tenantId: "t1" } as never)) as { problem: string | null; connected: boolean };
    expect(refreshInstagram).not.toHaveBeenCalled();
    expect(out.connected).toBe(false);
    expect(out.problem).toMatch(/could not check which Instagram account is connected/);
  });
});

afterEach(() => { vi.useRealTimers(); });

describe("Instagram current-connection cache boundary", () => {
  it.each(["cap_reached", "read_failed"])("hides yesterday's account when the new login cannot refresh (%s)", async (reason) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-19T13:00:00Z"));
    refreshInstagram.mockReset().mockResolvedValue({ ok: false, reason, message: "read unavailable" });
    const sb = fakeSb((t) => ({ data: t === "connector_metadata"
      ? [{ slug: "composio.instagram", team_id: "ca_new", connected_at: "2026-10-19T10:00:00Z" }]
      : t === "social_account_snapshots"
        ? [{ ...acct("2026-10-19", 123), created_at: "2026-10-19T09:00:00Z" }]
        : t === "social_post_metric_snapshots" ? [post("old", "2026-10-19", { views: 900 })] : [], error: null }));
    const out = await build({ sb, tenantId: "t1" } as never) as { account: unknown; top_posts: unknown[]; metrics: unknown[] };
    expect(refreshInstagram).toHaveBeenCalledOnce();
    expect(out.account).toBeNull();
    expect(out.top_posts).toEqual([]);
    expect(out.metrics).toEqual([]);
  });

  it("rejects a recent snapshot explicitly tagged with the previous connection", () => {
    const out = shapeInstagram([{ ...acct("2026-10-19", 9), account_id: "ig_old", connection_id: "ca_old", created_at: "2026-10-19T12:00:00Z" }], [], { team_id: "ca_new", connected_at: "2026-10-19T11:00:00Z" });
    expect(out.account).toBeNull();
  });

  it("keeps a renamed account's trend and excludes other accounts' posts even on the same day", () => {
    const out = shapeInstagram([
      { ...acct("2026-10-18", 10), account_id: "ig_1", username: "before", connection_id: "ca_old" },
      { ...acct("2026-10-19", 12), account_id: "ig_1", username: "renamed", connection_id: "ca_new" },
    ], [
      { ...post("ours", "2026-10-19", { views: 2 }), account_id: "ig_1" },
      { ...post("theirs", "2026-10-19", { views: 999 }), account_id: "ig_2" },
    ], { team_id: "ca_new" });
    expect(out.top_posts.map((p) => p.id)).toEqual(["ours"]);
    expect(out.metrics.find((r) => r.key === "followers")).toMatchObject({ value: 12, prev_value: 10 });
  });

  it("does not infer ownership for an orphan post or an unknown-account day", () => {
    const out = shapeInstagram([{ ...acct("2026-10-18", 999), username: null }, acct("2026-10-19", 1)], [
      post("unknown", "2026-10-18", { views: 999 }), post("orphan", "2026-10-17", { views: 888 }), post("ours", "2026-10-19", { views: 2 }),
    ]);
    expect(out.top_posts.map((p) => p.id)).toEqual(["ours"]);
    expect(out.metrics.find((r) => r.key === "followers")?.prev_value).toBeNull();
  });
});
