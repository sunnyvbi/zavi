
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ getConnectorToken: vi.fn(), getSecret: vi.fn(), forceRefreshConnector: vi.fn() }));
vi.mock("@/services/connectors/core/token", () => ({
  getConnectorToken: m.getConnectorToken,
  forceRefreshConnector: m.forceRefreshConnector,
}));
vi.mock("@/services/secrets/vault", () => ({ getSecret: m.getSecret }));

const cap = vi.hoisted(() => ({ consume: vi.fn(), release: vi.fn() }));
vi.mock("../read-cap", async () => {
  const actual = await vi.importActual<typeof import("../read-cap")>("../read-cap");
  return { ...actual, consumeReadSlot: cap.consume, releaseReadSlot: cap.release };
});

import {
  dailyViewsSeries,
  engagementsOf,
  fetchOwnedPosts,
  latestOwnedUsername,
  latestPerPost,
  readOwnedPostsShared,
  refreshOwnedPostsIfStale,
  snapshotOwnedPosts,
  formatOf,
  type SnapshotRow,
} from "../owned-posts";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const row = (id: string, day: string, imp: number): SnapshotRow => ({
  external_post_id: id,
  captured_on: day,
  posted_at: null,
  text: id,
  url: null,
  format: "post",
  has_link: false,
  metrics: { non_public: { impression_count: imp } },
});

describe("dailyViewsSeries", () => {
  it("charts the day-over-day difference per post, whole total on a post's first day after day one", () => {
    const rows = [
      row("a", "2026-09-08", 100),
      row("a", "2026-09-09", 150),
      row("b", "2026-09-09", 40),
      row("a", "2026-09-10", 160),
      row("b", "2026-09-10", 30),
    ];
    expect(dailyViewsSeries(rows)).toEqual([
      { day: "2026-09-08", views: 0 },
      { day: "2026-09-09", views: 90 },
      { day: "2026-09-10", views: 10 },
    ]);
  });

  it("keeps a post's last counter across a missing daily snapshot", () => {
    expect(dailyViewsSeries([
      row("a", "2026-09-08", 100), row("b", "2026-09-08", 10),
      row("b", "2026-09-09", 20),
      row("a", "2026-09-10", 120), row("b", "2026-09-10", 30),
    ])).toEqual([
      { day: "2026-09-08", views: 0 },
      { day: "2026-09-09", views: 10 },
      { day: "2026-09-10", views: 30 },
    ]);
  });

  it("empty in, empty out", () => {
    expect(dailyViewsSeries([])).toEqual([]);
  });
});

describe("latestPerPost / formatOf", () => {
  it("keeps the newest capture per post", () => {
    const l = latestPerPost([row("a", "2026-09-08", 1), row("a", "2026-09-10", 3), row("b", "2026-09-09", 2)]);
    expect(l.map((r) => [r.external_post_id, r.captured_on]).sort()).toEqual([["a", "2026-09-10"], ["b", "2026-09-09"]]);
  });
  it("names the shape a founder recognises", () => {
    expect(formatOf({ is_reply: false, is_repost: false, has_media: false })).toBe("post");
    expect(formatOf({ is_reply: true, is_repost: false, has_media: false })).toBe("reply");
    expect(formatOf({ is_reply: false, is_repost: true, has_media: true })).toBe("repost");
    expect(formatOf({ is_reply: false, is_repost: false, has_media: false, has_poll: true })).toBe("poll");
    expect(formatOf({ is_reply: false, is_repost: false, has_media: true })).toBe("media");
  });
});

function fakeClient(opts: { todayRows?: number; throttleError?: boolean } = {}) {
  const upserts: unknown[] = [];
  const updates: unknown[] = [];
  const client = {
    from: (table: string) => ({
      select: () => {
        const chain = {
          eq: () => chain,
          limit: async () =>
            opts.throttleError
              ? { data: null, error: { message: "relation does not exist" } }
              : { data: new Array(opts.todayRows ?? 0).fill({ id: "s" }) },
        };
        return chain;
      },
      upsert: async (rows: unknown) => {
        upserts.push({ table, rows });
        return { error: null };
      },
      update: (patch: unknown) => {
        const chain = { eq: () => chain, then: (r: (v: { error: null }) => void) => r({ error: null }) } as unknown as Promise<{ error: null }> & { eq: () => unknown };
        updates.push(patch);
        return chain;
      },
    }),
  };
  return { client: client as never, upserts, updates };
}

beforeEach(() => {
  m.getConnectorToken.mockReset().mockResolvedValue("tok");
  m.getSecret.mockReset().mockResolvedValue("4242");
  m.forceRefreshConnector.mockReset();
  cap.consume.mockReset().mockResolvedValue({ ok: true, used: 1, cap: 3 });
  cap.release.mockReset().mockResolvedValue(undefined);
});

describe("snapshotOwnedPosts", () => {
  it("writes one snapshot row per post for the read's UTC day", async () => {
    const { client, upserts } = fakeClient();
    const r = await snapshotOwnedPosts(
      TENANT,
      [{ id: "1", url: "u", created_at: "2026-09-09T00:00:00Z", text: "t", is_reply: false, is_repost: false, has_link: true, has_media: false, public_metrics: { like_count: 2 }, non_public_metrics: { impression_count: 9 }, organic_metrics: null, thumb_url: null, media_type: null, video_views: null }],
      "2026-09-10T13:00:00Z",
      client,
    );
    expect(r.snapshots).toBe(1);
    const u = upserts[0] as { table: string; rows: Array<Record<string, unknown>> };
    expect(u.table).toBe("social_post_metric_snapshots");
    expect(u.rows[0]).toMatchObject({ tenant_id: TENANT, channel: "x", external_post_id: "1", captured_on: "2026-09-10", format: "post", has_link: true });
  });
});

describe("refreshOwnedPostsIfStale", () => {
  it("skips the metered read when today's snapshot exists", async () => {
    const { client } = fakeClient({ todayRows: 1 });
    vi.stubGlobal("fetch", vi.fn());
    const r = await refreshOwnedPostsIfStale(TENANT, { client });
    expect(r).toEqual({ read: false, reason: "fresh_today" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED on cost: an unreadable throttle (table not migrated) never triggers a metered read", async () => {
    const { client } = fakeClient({ throttleError: true });
    vi.stubGlobal("fetch", vi.fn());
    const r = await refreshOwnedPostsIfStale(TENANT, { client });
    expect(r).toMatchObject({ read: false, error_code: "x_snapshot_unavailable" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads and snapshots when stale, and reports a stable code when X refuses", async () => {
    const { client, upserts } = fakeClient();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: "7", text: "x" }] }) })));
    const r = await refreshOwnedPostsIfStale(TENANT, { client });
    expect(r.read).toBe(true);
    expect(upserts.map((u) => (u as { table: string }).table)).toEqual(["social_post_metric_snapshots", "social_account_snapshots"]);

    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 402, json: async () => ({}) })));
    const paused = await refreshOwnedPostsIfStale(TENANT, { client, force: true });
    expect(paused).toMatchObject({ read: false, error_code: "x_out_of_credits" });
  });
});

describe("fetchOwnedPosts — connected-but-unrefreshable is not disconnected", () => {
  beforeEach(() => {
    m.getConnectorToken.mockReset();
    m.getSecret.mockReset();
  });

  it("reports the real reason, and that reconnecting will not fix OUR misconfiguration", async () => {
    const { fetchOwnedPosts } = await import("../owned-posts");
    m.getConnectorToken.mockRejectedValue(
      new Error("X_SOCIAL_CLIENT_ID and X_SOCIAL_CLIENT_SECRET must be set"),
    );
    m.getSecret.mockResolvedValue("stored-token-or-user-id");
    await expect(fetchOwnedPosts(TENANT)).rejects.toMatchObject({
      code: "x_token_refresh_failed",
    });
    await expect(fetchOwnedPosts(TENANT)).rejects.toThrow(/X_SOCIAL_CLIENT_ID/);
    await expect(fetchOwnedPosts(TENANT)).rejects.toThrow(/will NOT help/);
  });

  it("sends the operator to reconnect when X actually revoked the grant", async () => {
    const { fetchOwnedPosts } = await import("../owned-posts");
    m.getSecret.mockResolvedValue("stored-token-or-user-id");
    for (const msg of [
      "X token HTTP 400: {\"error\":\"invalid_grant\"}",
      "x_social not connected (no refresh token)",
      "X token HTTP 401: unauthorized",
    ]) {
      m.getConnectorToken.mockRejectedValue(new Error(msg));
      await expect(fetchOwnedPosts(TENANT)).rejects.toMatchObject({ code: "x_not_authorized" });
    }
  });

  it("does not blame the operator for a transient failure at X", async () => {
    const { fetchOwnedPosts } = await import("../owned-posts");
    m.getSecret.mockResolvedValue("stored-token-or-user-id");
    for (const msg of ["X token HTTP 503: upstream", "X refresh response missing access_token"]) {
      m.getConnectorToken.mockRejectedValue(new Error(msg));
      await expect(fetchOwnedPosts(TENANT)).rejects.toMatchObject({ code: "x_token_refresh_failed" });
    }
  });

  it("reconnectFixesRefresh splits the two classes", async () => {
    const { reconnectFixesRefresh } = await import("../owned-posts");
    expect(reconnectFixesRefresh("X token HTTP 400: invalid_grant")).toBe(true);
    expect(reconnectFixesRefresh("x_social not connected (no refresh token)")).toBe(true);
    expect(reconnectFixesRefresh("X_SOCIAL_CLIENT_ID and X_SOCIAL_CLIENT_SECRET must be set")).toBe(false);
    expect(reconnectFixesRefresh("X token HTTP 500: boom")).toBe(false);
  });

  it("still says not-connected when nothing is stored", async () => {
    const { fetchOwnedPosts } = await import("../owned-posts");
    m.getConnectorToken.mockResolvedValue(null);
    m.getSecret.mockResolvedValue(null);
    await expect(fetchOwnedPosts(TENANT)).rejects.toMatchObject({
      code: "x_not_connected",
    });
  });
});

describe("fetchOwnedPosts — the metered-read cap", () => {
  beforeEach(() => {
    m.getConnectorToken.mockReset().mockResolvedValue("tok");
    m.getSecret.mockReset().mockResolvedValue("4242");
  });

  it("spends no read when the allowance is gone, and says whose limit it is", async () => {
    cap.consume.mockResolvedValue({ ok: false, used: 3, cap: 3, reason: "cap_reached" });
    vi.stubGlobal("fetch", vi.fn());
    await expect(fetchOwnedPosts(TENANT)).rejects.toMatchObject({ code: "x_read_cap_reached" });
    expect(fetch).not.toHaveBeenCalled();
    expect(cap.release).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED: an unreadable counter spends nothing rather than guessing", async () => {
    cap.consume.mockResolvedValue({ ok: false, used: 3, cap: 3, reason: "unavailable" });
    vi.stubGlobal("fetch", vi.fn());
    await expect(fetchOwnedPosts(TENANT)).rejects.toMatchObject({ code: "x_read_cap_unavailable" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reserves BEFORE the request, so two callers cannot both pass one check", async () => {
    const order: string[] = [];
    cap.consume.mockImplementation(async () => {
      order.push("consume");
      return { ok: true, used: 1, cap: 3 };
    });
    vi.stubGlobal("fetch", vi.fn(async () => {
      order.push("fetch");
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }));
    await fetchOwnedPosts(TENANT);
    expect(order).toEqual(["consume", "fetch"]);
  });

  it.each([
    [429, "x_rate_limited"],
    [402, "x_out_of_credits"],
    [503, "x_read_failed"],
  ])("refunds the slot when X answers %s (nothing was billed)", async (status, code) => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: status < 400, status, json: async () => ({}) })));
    await expect(fetchOwnedPosts(TENANT)).rejects.toMatchObject({ code });
    expect(cap.release).toHaveBeenCalledWith(TENANT);
  });

  it("refunds when the request dies before any response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("timeout");
    }));
    await expect(fetchOwnedPosts(TENANT)).rejects.toMatchObject({ code: "x_read_failed" });
    expect(cap.release).toHaveBeenCalledWith(TENANT);
  });

  it("does NOT refund a 403: X served an authorization decision, and retrying loops", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ detail: "no" }) })));
    await expect(fetchOwnedPosts(TENANT)).rejects.toMatchObject({ code: "x_not_authorized" });
    expect(cap.release).not.toHaveBeenCalled();
  });

  it("keeps the slot on a successful read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: "1" }] }) })));
    await fetchOwnedPosts(TENANT);
    expect(cap.release).not.toHaveBeenCalled();
  });
});

describe("fetchOwnedPosts — media expansion", () => {
  beforeEach(() => {
    m.getConnectorToken.mockReset().mockResolvedValue("tok");
    m.getSecret.mockReset().mockResolvedValue("4242");
  });

  const reply = (post: Record<string, unknown>, media: Array<Record<string, unknown>>) => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [post], includes: { media } }),
  });

  it("asks X for the media fields it needs", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({ id: "1" }, [])));
    await fetchOwnedPosts(TENANT);
    const url = String((fetch as unknown as { mock: { calls: Array<[URL]> } }).mock.calls[0][0]);
    expect(url).toContain("expansions=attachments.media_keys");
    expect(url).toContain("preview_image_url");
  });

  it("takes media.url for a photo", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      reply(
        { id: "1", attachments: { media_keys: ["3_1"] } },
        [{ media_key: "3_1", type: "photo", url: "https://pbs.twimg.com/media/a.jpg" }],
      ),
    ));
    const r = await fetchOwnedPosts(TENANT);
    expect(r.items[0]).toMatchObject({
      thumb_url: "https://pbs.twimg.com/media/a.jpg",
      media_type: "photo",
      has_media: true,
    });
    expect(formatOf(r.items[0])).toBe("photo");
  });

  it("falls back to preview_image_url for a video, and carries its view_count", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      reply(
        { id: "1", attachments: { media_keys: ["7_9"] } },
        [{ media_key: "7_9", type: "video", preview_image_url: "https://pbs.twimg.com/ext/v.jpg", public_metrics: { view_count: 4200 } }],
      ),
    ));
    const r = await fetchOwnedPosts(TENANT);
    expect(r.items[0]).toMatchObject({
      thumb_url: "https://pbs.twimg.com/ext/v.jpg",
      media_type: "video",
      video_views: 4200,
    });
    expect(formatOf(r.items[0])).toBe("video");
  });

  it("a text-only post carries no creative and no media type", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({ id: "1", text: "just words" }, [])));
    const r = await fetchOwnedPosts(TENANT);
    expect(r.items[0]).toMatchObject({ thumb_url: null, media_type: null, video_views: null, has_media: false });
  });

  it("a media_key with no matching include does not crash the read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({ id: "1", attachments: { media_keys: ["missing"] } }, [])));
    const r = await fetchOwnedPosts(TENANT);
    expect(r.items[0]).toMatchObject({ thumb_url: null, has_media: true });
  });
});

describe("engagementsOf", () => {
  it("prefers X's own total over our sum of the parts", () => {
    expect(
      engagementsOf({
        public: { like_count: 1, reply_count: 1, retweet_count: 1, quote_count: 1, bookmark_count: 1 },
        non_public: { engagements: 97 },
      }),
    ).toBe(97);
  });

  it("sums the public counters past the 30-day window, where the private block is gone", () => {
    expect(
      engagementsOf({ public: { like_count: 8, reply_count: 1, retweet_count: 2, quote_count: 1, bookmark_count: 3 } }),
    ).toBe(15);
  });

  it("a genuine zero from X is honoured, not treated as missing", () => {
    expect(engagementsOf({ public: { like_count: 5 }, non_public: { engagements: 0 } })).toBe(0);
  });

  it("nothing in, zero out", () => {
    expect(engagementsOf(null)).toBe(0);
    expect(engagementsOf({})).toBe(0);
  });
});

describe("refreshOwnedPostsIfStale — the account, in the same slot", () => {
  it("a failed profile read does not fail the post read", async () => {
    const { client, upserts } = fakeClient();
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? { ok: true, status: 200, json: async () => ({ data: [{ id: "7", text: "x" }] }) }
        : { ok: false, status: 503, json: async () => ({}) };
    }));
    const r = await refreshOwnedPostsIfStale(TENANT, { client });
    expect(r.read).toBe(true);
    expect(upserts).toHaveLength(1);
    expect(cap.consume).toHaveBeenCalledTimes(1);
  });

  it("stores what the profile checks and new-follows need", async () => {
    const { client, upserts } = fakeClient();
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? { ok: true, status: 200, json: async () => ({ data: [] }) }
        : {
            ok: true,
            status: 200,
            json: async () => ({
              data: {
                id: "4242",
                username: "UpcarCarRental",
                name: "Upcar",
                description: "",
                location: "California",
                verified: false,
                profile_image_url: "https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png",
                pinned_tweet_id: "99",
                public_metrics: { followers_count: 120, following_count: 30, tweet_count: 40 },
              },
            }),
          };
    }));
    await refreshOwnedPostsIfStale(TENANT, { client });
    const account = upserts.find((u) => (u as { table: string }).table === "social_account_snapshots") as { rows: Record<string, unknown> };
    expect(account.rows).toMatchObject({
      channel: "x",
      username: "UpcarCarRental",
      description: null,
      profile_banner_url: null,
      pinned_post_id: "99",
      location: "California",
      verified: false,
      followers_count: 120,
      post_count: 40,
    });
  });
});

describe("readOwnedPostsShared", () => {
  const today = new Date().toISOString().slice(0, 10);
  const snapClient = (rows: unknown[]) =>
    ({
      from: () => {
        const chain: Record<string, unknown> = {};
        Object.assign(chain, { select: () => chain, eq: () => chain, gte: () => chain, order: () => chain, limit: async () => ({ data: rows, error: null }) });
        return chain;
      },
    }) as never;
  beforeEach(() => {
    m.getConnectorToken.mockReset().mockResolvedValue("tok");
    m.getSecret.mockReset().mockResolvedValue("4242");
  });

  it("the allowance spent: serves today's stored read instead of refusing", async () => {
    cap.consume.mockResolvedValue({ ok: false, used: 1, cap: 1, reason: "cap_reached" });
    vi.stubGlobal("fetch", vi.fn());
    const rows = [{ external_post_id: "9", captured_on: today, posted_at: "2026-09-17T10:00:00Z", text: "stored", url: "https://x.com/i/web/status/9", format: "reply", has_link: true, thumb_url: null, media_type: null, metrics: { public: { like_count: 4 }, non_public: { impression_count: 50 } } }];
    const r = await readOwnedPostsShared(TENANT, { client: snapClient(rows) });
    expect(fetch).not.toHaveBeenCalled();
    expect(r.from_snapshot).toBe(true);
    expect(r.items[0]).toMatchObject({ id: "9", text: "stored", is_reply: true, has_link: true, public_metrics: { like_count: 4 }, non_public_metrics: { impression_count: 50 } });
  });

  it("the allowance spent and nothing stored today: the cap error still surfaces", async () => {
    cap.consume.mockResolvedValue({ ok: false, used: 1, cap: 1, reason: "cap_reached" });
    vi.stubGlobal("fetch", vi.fn());
    await expect(readOwnedPostsShared(TENANT, { client: snapClient([{ external_post_id: "1", captured_on: "2020-01-01", metrics: {} }]) })).rejects.toMatchObject({ code: "x_read_cap_reached" });
  });

  it("the allowance unspent: a real read, snapshotted", async () => {
    const { client, upserts } = fakeClient();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: "7", text: "x" }] }) })));
    const r = await readOwnedPostsShared(TENANT, { client });
    expect(r.from_snapshot).toBe(false);
    expect(upserts).toHaveLength(1);
  });

  it("any other failure is not papered over with old data", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) })));
    await expect(readOwnedPostsShared(TENANT, { client: snapClient([]) })).rejects.toMatchObject({ code: "x_not_authorized" });
  });
});

describe("latestOwnedUsername", () => {
  const client = (
    snaps: Array<{ username: unknown; created_at: string }> | null,
    opts: { connectedAt?: string | null; error?: unknown } = {},
  ) =>
    ({
      from: (table: string) => {
        const gtes: Array<[string, string]> = [];
        const q: Record<string, unknown> = {};
        for (const k of ["select", "eq", "order"]) q[k] = () => q;
        q.gte = (k: string, v: string) => (gtes.push([k, v]), q);
        q.limit = async () => {
          if (table === "connector_metadata") {
            return { data: opts.connectedAt === null ? [] : [{ connected_at: opts.connectedAt ?? "2026-10-01T00:00:00Z" }], error: null };
          }
          if (opts.error) return { data: null, error: opts.error };
          const after = gtes.find(([k]) => k === "created_at")?.[1];
          return { data: snaps?.filter((r) => !after || r.created_at >= after) ?? null, error: null };
        };
        return q;
      },
    }) as never;
  const t = "2026-10-05T00:00:00Z";
  it("returns the newest stored username without the @, null when none or on error", async () => {
    expect(await latestOwnedUsername(TENANT, client([{ username: "@brand", created_at: t }]))).toBe("brand");
    expect(await latestOwnedUsername(TENANT, client([]))).toBeNull();
    expect(await latestOwnedUsername(TENANT, client([{ username: null, created_at: t }]))).toBeNull();
    expect(await latestOwnedUsername(TENANT, client(null, { error: { message: "x" } }))).toBeNull();
  });
  it("ignores a snapshot taken before the current connection (a reconnect to another account)", async () => {
    const snaps = [{ username: "old_account", created_at: "2026-10-01T00:00:00Z" }];
    expect(await latestOwnedUsername(TENANT, client(snaps, { connectedAt: "2026-10-03T00:00:00Z" }))).toBeNull();
  });
  it("is null when the connection is unknown", async () => {
    expect(await latestOwnedUsername(TENANT, client([{ username: "brand", created_at: t }], { connectedAt: null }))).toBeNull();
  });
});

describe("published text URL binding", () => {
  it("expands X-owned URL entities without touching other links", async () => {
    const { ownedPostText } = await import("../owned-posts");
    expect(ownedPostText("See https://t.co/a and https://example.com", [{ url: "https://t.co/a", expanded_url: "https://business.test/trips?q=1" }])).toBe("See https://business.test/trips?q=1 and https://example.com");
    expect(ownedPostText("See https://t.co/a.", [{ url: "https://t.co/a", expanded_url: "https://business.test/trips" }])).toBe("See https://business.test/trips.");
    expect(ownedPostText("See https://t.co/abc", [{ url: "https://t.co/a", expanded_url: "https://business.test/trips" }])).toBe("See https://t.co/abc");
    expect(ownedPostText("See https://t.co/a", [{ url: "https://t.co/a", expanded_url: "javascript:bad" }])).toBe("See https://t.co/a");
  });
});
