
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ getConnectorToken: vi.fn(), getSecret: vi.fn(), forceRefreshConnector: vi.fn() }));
vi.mock("@/services/connectors/core/token", () => ({
  getConnectorToken: m.getConnectorToken,
  forceRefreshConnector: m.forceRefreshConnector,
}));
vi.mock("@/services/secrets/vault", () => ({ getSecret: m.getSecret }));

const cap = vi.hoisted(() => ({ consume: vi.fn(), release: vi.fn() }));
vi.mock("@/services/x-social/read-cap", async () => {
  const actual = await vi.importActual<typeof import("@/services/x-social/read-cap")>("@/services/x-social/read-cap");
  return { ...actual, consumeReadSlot: cap.consume, releaseReadSlot: cap.release };
});

const own = vi.hoisted(() => ({ latest: vi.fn() }));
vi.mock("@/services/x-social/owned-posts", async () => {
  const actual = await vi.importActual<typeof import("@/services/x-social/owned-posts")>("@/services/x-social/owned-posts");
  return { ...actual, latestOwnedUsername: own.latest };
});

import { xSocialReadPostMetricsTool } from "../read_post_metrics";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const ctx = { tenant_id: TENANT, log: vi.fn() } as never;

function mockFetch(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: status < 400, status, json: async () => body })));
}

beforeEach(() => {
  m.forceRefreshConnector.mockReset().mockResolvedValue(undefined);
  m.getConnectorToken.mockReset().mockResolvedValue("tok");
  m.getSecret.mockReset().mockResolvedValue("4242");
  cap.consume.mockReset().mockResolvedValue({ ok: true, used: 1, cap: 3 });
  cap.release.mockReset().mockResolvedValue(undefined);
  own.latest.mockReset().mockResolvedValue(null);
});

describe("x_social_read_post_metrics handle", () => {
  it("returns the stored username X returned, with no extra X call, and null when unknown", async () => {
    mockFetch(200, { data: [] });
    own.latest.mockResolvedValueOnce("brandhandle");
    const out = (await xSocialReadPostMetricsTool.execute(ctx, {})) as { handle: string | null };
    expect(out.handle).toBe("brandhandle");
    expect(own.latest).toHaveBeenCalledWith(TENANT);
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.every((c) => !String(c[0]).includes("/users/me"))).toBe(true);
    const none = (await xSocialReadPostMetricsTool.execute(ctx, {})) as { handle: string | null };
    expect(none.handle).toBeNull();
  });
});

describe("x_social_read_post_metrics", () => {
  it("reads the tenant's own posts with the metric fields inside a 30-day window", async () => {
    mockFetch(200, {
      data: [
        {
          id: "1",
          created_at: "2026-09-01T00:00:00Z",
          text: "root post",
          entities: { urls: [{ url: "https://t.co/x" }] },
          public_metrics: { like_count: 3, impression_count: 120 },
          non_public_metrics: { url_link_clicks: 4, user_profile_clicks: 1, impression_count: 120 },
        },
        { id: "2", created_at: "2026-09-02T00:00:00Z", text: "a reply", referenced_tweets: [{ type: "replied_to", id: "9" }] },
      ],
      errors: [{ detail: "metrics unavailable for 3" }],
    });
    const out = (await xSocialReadPostMetricsTool.execute(ctx, {})) as {
      items: Array<Record<string, unknown>>;
      partial_errors: string[];
      provenance: string;
    };
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toMatch(/^https:\/\/api\.x\.com\/2\/users\/4242\/tweets\?/);
    expect(url.searchParams.get("max_results")).toBe("20");
    expect(url.searchParams.get("tweet.fields")).toContain("non_public_metrics");
    expect(url.searchParams.get("start_time")).toBeTruthy();
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(m.getConnectorToken).toHaveBeenCalledWith(TENANT, "x_social", "x_social.access_token");
    expect(m.getSecret).toHaveBeenCalledWith(TENANT, "x_social.user_id");
    expect(out.provenance).toBe("owned");
    expect(out.items[0]).toMatchObject({ id: "1", has_link: true, is_reply: false, url: "https://x.com/i/web/status/1" });
    expect(out.items[0].non_public_metrics).toEqual({ url_link_clicks: 4, user_profile_clicks: 1, impression_count: 120 });
    expect(out.items[1]).toMatchObject({ is_reply: true, has_link: false, public_metrics: null });
    expect(out.partial_errors).toEqual(["metrics unavailable for 3"]);
  });

  it("refuses when X is not connected", async () => {
    m.getConnectorToken.mockResolvedValue(null);
    await expect(xSocialReadPostMetricsTool.execute(ctx, {})).rejects.toMatchObject({ code: "x_not_connected" });
  });

  it("on 401 force-refreshes once (persisted) and retries with the new token", async () => {
    m.getConnectorToken.mockResolvedValueOnce("tok_stale").mockResolvedValueOnce("tok_new");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: URL, init: RequestInit) =>
        (init.headers as Record<string, string>).Authorization === "Bearer tok_new"
          ? { ok: true, status: 200, json: async () => ({ data: [] }) }
          : { ok: false, status: 401, json: async () => ({ title: "Unauthorized" }) },
      ),
    );
    const out = (await xSocialReadPostMetricsTool.execute(ctx, {})) as { items: unknown[] };
    expect(out.items).toEqual([]);
    expect(m.forceRefreshConnector).toHaveBeenCalledTimes(1);
  });

  it.each([
    [402, "x_out_of_credits"],
    [403, "x_not_authorized"],
    [429, "x_rate_limited"],
  ])("maps HTTP %s to %s", async (status, code) => {
    mockFetch(status, { title: "nope" });
    await expect(xSocialReadPostMetricsTool.execute(ctx, {})).rejects.toMatchObject({ code });
  });
});

import { snapshotLedgerMetrics } from "../read_post_metrics";

describe("snapshotLedgerMetrics", () => {
  function fakeClient(updateError: { message: string } | null = null) {
    const calls: Array<{ patch: unknown; eqs: unknown[][] }> = [];
    const client = {
      from: () => ({
        update: (patch: unknown) => {
          const rec = { patch, eqs: [] as unknown[][] };
          calls.push(rec);
          const chain = {
            eq: (...a: unknown[]) => {
              rec.eqs.push(a);
              return rec.eqs.length === 2 ? Promise.resolve({ error: updateError }) : chain;
            },
          };
          return chain;
        },
      }),
    };
    return { client: client as never, calls };
  }

  const items = [
    { id: "1", url: "", created_at: "", text: "", is_reply: false, is_repost: false, has_link: true, has_media: false, public_metrics: { like_count: 3 }, non_public_metrics: { impression_count: 9 }, organic_metrics: null, thumb_url: null, media_type: null, video_views: null },
    { id: "", url: "", created_at: "", text: "", is_reply: false, is_repost: false, has_link: false, has_media: false, public_metrics: null, non_public_metrics: null, organic_metrics: null, thumb_url: null, media_type: null, video_views: null },
  ];

  it("writes one update per post id, keyed on channel x + external_post_id (tenant filter comes from the facade)", async () => {
    const { client, calls } = fakeClient();
    const n = await snapshotLedgerMetrics(TENANT, items, "2026-09-10T13:00:00Z", client);
    expect(n).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].patch).toEqual({
      metrics: { public: { like_count: 3 }, non_public: { impression_count: 9 }, organic: null },
      metrics_read_at: "2026-09-10T13:00:00Z",
    });
    expect(calls[0].eqs).toEqual([["channel", "x"], ["external_post_id", "1"]]);
  });

  it("swallows a write error and reports zero written", async () => {
    const { client } = fakeClient({ message: "boom" });
    await expect(snapshotLedgerMetrics(TENANT, items, "t", client)).resolves.toBe(0);
  });

  it("without a service client (no env) it skips silently and the read still returns", async () => {
    mockFetch(200, { data: [{ id: "7", text: "x" }] });
    const out = (await xSocialReadPostMetricsTool.execute(ctx, {})) as { items: unknown[] };
    expect(out.items).toHaveLength(1);
  });
});
