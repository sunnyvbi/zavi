
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ exec: vi.fn(), resolve: vi.fn() }));
vi.mock("@/services/connectors/composio/api", () => ({ composioExecuteTool: m.exec }));
vi.mock("@/services/connectors/composio/account", () => ({ resolveOwnedComposioAccount: m.resolve }));
vi.mock("@/services/connectors/pipedream/api", () => ({
  proxyRequest: vi.fn(() => { throw new Error("pipedream must never be called"); }),
  listConnectedAccounts: vi.fn(() => { throw new Error("pipedream must never be called"); }),
}));

import { youtubeInsightsReadTool, iso8601ToSeconds } from "../read";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const ctx = { tenant_id: TENANT, log: vi.fn() } as never;
const OWNED = { tenant_id: TENANT, toolkit: "youtube", connected_account_id: "ca_yt" };

beforeEach(() => {
  m.exec.mockReset();
  m.resolve.mockReset().mockResolvedValue(OWNED);
});

describe("youtube_insights_read (composio)", () => {
  it("reads channel statistics, lists the channel's videos, and details them", async () => {
    m.exec
      .mockResolvedValueOnce({ ok: true, status: 200, error: null, data: { items: [{ statistics: { viewCount: "1200", subscriberCount: "45", videoCount: "2" } }] } })
      .mockResolvedValueOnce({ ok: true, status: 200, error: null, data: { items: [
        { contentDetails: { videoId: "abc123" } }, { snippet: { resourceId: { videoId: "def456" } } },
      ] } })
      .mockResolvedValueOnce({ ok: true, status: 200, error: null, data: { response_data: { items: [
        { id: "def456", snippet: { title: "Second", publishedAt: "2026-09-02" }, statistics: { viewCount: "400", likeCount: "9" }, contentDetails: { duration: "PT45S" } },
        { id: "abc123", snippet: { title: "First", publishedAt: "2026-09-01" }, statistics: { viewCount: "800", likeCount: "20", commentCount: "3" }, contentDetails: { duration: "PT7M37S" } },
      ] } } });
    const out = (await youtubeInsightsReadTool.execute(ctx, {})) as {
      channel_totals: Record<string, unknown>; videos: Array<Record<string, unknown>>; cannot_see: string[];
    };
    expect(m.resolve).toHaveBeenCalledWith(TENANT, "youtube");
    expect(m.exec.mock.calls.map((c) => c[0].tool_slug)).toEqual([
      "YOUTUBE_GET_CHANNEL_STATISTICS", "YOUTUBE_LIST_CHANNEL_VIDEOS", "YOUTUBE_GET_VIDEO_DETAILS_BATCH",
    ]);
    for (const c of m.exec.mock.calls) expect(c[0]).toMatchObject({ user_id: TENANT, connected_account_id: "ca_yt" });
    expect(m.exec.mock.calls[0][0].arguments).toMatchObject({ mine: true });
    expect(m.exec.mock.calls[2][0].arguments.id).toEqual(["abc123", "def456"]);
    expect(out.channel_totals).toEqual({ views: 1200, subscriberCount: 45, videoCount: 2 });
    expect(out.videos[0]).toEqual({ video: "abc123", title: "First", published_at: "2026-09-01", duration_seconds: 457, views: 800, likes: 20, comments: 3 });
    expect(out.videos[1]).toMatchObject({ video: "def456", views: 400, likes: 9 });
    expect(out.videos[1].comments).toBeUndefined();
    expect(out.cannot_see).toEqual(expect.arrayContaining(["watch time", "average view duration"]));
  });

  it("returns the channel's title and @handle from the snippet it already reads, null when absent", async () => {
    m.exec
      .mockResolvedValueOnce({ ok: true, status: 200, error: null, data: { items: [{ snippet: { title: "Brand Channel", customUrl: "@brandchannel" }, statistics: { viewCount: "5" } }] } })
      .mockResolvedValueOnce({ ok: true, status: 200, error: null, data: { items: [] } });
    const out = (await youtubeInsightsReadTool.execute(ctx, {})) as { channel_title: string | null; handle: string | null };
    expect(out).toMatchObject({ channel_title: "Brand Channel", handle: "brandchannel" });
    expect(m.exec).toHaveBeenCalledTimes(2);
    m.exec
      .mockResolvedValueOnce({ ok: true, status: 200, error: null, data: { items: [{ statistics: { viewCount: "5" } }] } })
      .mockResolvedValueOnce({ ok: true, status: 200, error: null, data: { items: [] } });
    expect(await youtubeInsightsReadTool.execute(ctx, {})).toMatchObject({ channel_title: null, handle: null });
  });

  it("refuses with the composio connector slug when no owned account exists", async () => {
    m.resolve.mockResolvedValue(null);
    await expect(youtubeInsightsReadTool.execute(ctx, {})).rejects.toMatchObject({
      code: "youtube_analytics_not_connected", meta: { connector_slug: "composio.youtube" },
    });
    expect(m.exec).not.toHaveBeenCalled();
  });

  it("a failed channel read is reported, never guessed around", async () => {
    m.exec
      .mockResolvedValueOnce({ ok: false, status: 200, error: "no channel", data: null })
      .mockResolvedValueOnce({ ok: true, status: 200, error: null, data: { items: [] } });
    const out = (await youtubeInsightsReadTool.execute(ctx, {})) as { channel_totals: unknown; channel_error: string; videos: unknown[] };
    expect(out.channel_totals).toBeNull();
    expect(out.channel_error).toBe("no channel");
    expect(out.videos).toEqual([]);
    expect(m.exec).toHaveBeenCalledTimes(2);
  });

  it("reads a response_data that arrives as a JSON-encoded string", async () => {
    m.exec
      .mockResolvedValueOnce({ ok: true, status: 200, error: null, data: { response_data: JSON.stringify({ items: [{ statistics: { viewCount: "10", subscriberCount: "2", videoCount: "1" } }] }) } })
      .mockResolvedValueOnce({ ok: true, status: 200, error: null, data: { response_data: JSON.stringify({ items: [{ contentDetails: { videoId: "v1" } }] }) } })
      .mockResolvedValueOnce({ ok: true, status: 200, error: null, data: { response_data: JSON.stringify({ items: [{ id: "v1", statistics: { viewCount: "7" } }] }) } });
    const out = (await youtubeInsightsReadTool.execute(ctx, {})) as { channel_totals: unknown; videos: unknown[]; videos_error: unknown };
    expect(out.channel_totals).toEqual({ views: 10, subscriberCount: 2, videoCount: 1 });
    expect(out.videos).toEqual([{ video: "v1", views: 7 }]);
    expect(out.videos_error).toBeNull();
  });

  it("an unparseable successful payload is a read error, not an empty success", async () => {
    m.exec
      .mockResolvedValueOnce({ ok: true, status: 200, error: null, data: { response_data: "{not json" } })
      .mockResolvedValueOnce({ ok: true, status: 200, error: null, data: "<html>oops" });
    const out = (await youtubeInsightsReadTool.execute(ctx, {})) as { channel_totals: unknown; channel_error: string; videos: unknown[]; videos_error: string };
    expect(out.channel_totals).toBeNull();
    expect(out.channel_error).toBe("composio_unparseable_response");
    expect(out.videos).toEqual([]);
    expect(out.videos_error).toBe("composio_unparseable_response");
  });
});

describe("iso8601ToSeconds", () => {
  it("parses the ISO-8601 durations YouTube returns", () => {
    expect(iso8601ToSeconds("PT7M37S")).toBe(457);
    expect(iso8601ToSeconds("PT1H2M3S")).toBe(3723);
    expect(iso8601ToSeconds("PT45S")).toBe(45);
  });

  it("returns null rather than a zero the model could divide by", () => {
    expect(iso8601ToSeconds(undefined)).toBeNull();
    expect(iso8601ToSeconds("")).toBeNull();
    expect(iso8601ToSeconds("garbage")).toBeNull();
    expect(iso8601ToSeconds("PT0S")).toBeNull();
  });
});
