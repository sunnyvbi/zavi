
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { youtubeSearchVideosTool } from "../search_videos";
import { youtubeVideoStatsTool } from "../video_stats";
import { youtubeChannelStatsTool } from "../channel_stats";
import { iso8601DurationToSeconds, MAX_SEARCHES_PER_RUN, __resetSearchSpend } from "../client";
import { ExpectedToolError } from "@/services/tools/types";

const CTX = { tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204", log: () => {} };

type Call = { url: string };
function stub(body: unknown, status = 200, text?: string): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      calls.push({ url: String(url) });
      return {
        ok: status < 400,
        status,
        json: async () => body,
        text: async () => text ?? JSON.stringify(body),
      };
    }),
  );
  return calls;
}

beforeEach(() => {
  process.env.YOUTUBE_DATA_API_KEY = "test-key";
  __resetSearchSpend();
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.YOUTUBE_DATA_API_KEY;
});

describe("youtube_search_videos", () => {
  it("returns raw rows in YouTube's own order and passes the filters through", async () => {
    const calls = stub({
      items: [
        {
          id: { videoId: "abcdefghijk" },
          snippet: {
            title: "Renting Out My Car On Turo (Full Walkthrough)",
            channelTitle: "Some Channel",
            channelId: "UC123",
            publishedAt: "2021-03-04T10:00:00Z",
            description: "how it went",
          },
        },
        { id: { channelId: "UCnope" }, snippet: { title: "a channel" } },
      ],
    });

    const out = (await youtubeSearchVideosTool.execute(CTX, {
      query: "how to rent out my car",
      duration: "short",
      published_after: "2025-09-04T00:00:00Z",
      order: "viewCount",
      channel_id: "UCmine",
    })) as { items: unknown[]; provenance: string; fetched_at: string };

    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({
      video_id: "abcdefghijk",
      published_at: "2021-03-04T10:00:00Z",
    });
    expect(out.provenance).toBe("public");
    expect(out.fetched_at).toMatch(/^\d{4}-/);

    const u = calls[0]!.url;
    expect(u).toContain("videoDuration=short");
    expect(u).toContain("order=viewCount");
    expect(u).toContain("channelId=UCmine");
    expect(u).toContain("type=video");
    expect(u).toContain("key=test-key");
  });

  it("omits videoDuration entirely when duration is 'any'", async () => {
    const calls = stub({ items: [] });
    await youtubeSearchVideosTool.execute(CTX, { query: "anything" });
    expect(calls[0]!.url).not.toContain("videoDuration");
  });
});

describe("youtube_video_stats", () => {
  it("returns per-video public counts and never invents a hidden one", async () => {
    stub({
      items: [
        {
          id: "abcdefghijk",
          snippet: { title: "A", channelTitle: "C", publishedAt: "2021-03-04T10:00:00Z" },
          statistics: { viewCount: "412000", likeCount: "1200", commentCount: "88" },
          contentDetails: { duration: "PT12M30S" },
        },
        {
          id: "bbbbbbbbbbb",
          snippet: { title: "B", channelTitle: "C", publishedAt: "2026-01-01T00:00:00Z" },
          statistics: { likeCount: "3" },
          contentDetails: { duration: "PT45S" },
        },
      ],
    });

    const out = (await youtubeVideoStatsTool.execute(CTX, {
      video_ids: ["abcdefghijk", "bbbbbbbbbbb", "ccccccccccc"],
    })) as {
      items: Array<Record<string, unknown>>;
      missing: string[];
      cannot_see: string[];
    };

    expect(out.items[0]).toMatchObject({
      view_count: 412000,
      duration_seconds: 750,
      short_length: false,
    });
    expect(out.items[1]!.view_count).toBeNull();
    expect(out.items[1]!.short_length).toBe(true);
    expect(out.missing).toEqual(["ccccccccccc"]);
    expect(out.cannot_see).toContain("click_through_rate");
    expect(out.cannot_see).toContain("watch_time");
  });

  it("dates the Shorts boundary instead of assuming a flat 60 seconds", async () => {
    stub({
      items: [
        {
          id: "newnewnewne",
          snippet: { title: "N", channelTitle: "C", publishedAt: "2026-05-01T00:00:00Z" },
          statistics: { viewCount: "10" },
          contentDetails: { duration: "PT2M" },
        },
        {
          id: "oldoldoldol",
          snippet: { title: "O", channelTitle: "C", publishedAt: "2024-01-01T00:00:00Z" },
          statistics: { viewCount: "10" },
          contentDetails: { duration: "PT2M" },
        },
        {
          id: "longlonglon",
          snippet: { title: "L", channelTitle: "C", publishedAt: "2026-05-01T00:00:00Z" },
          statistics: { viewCount: "10" },
          contentDetails: { duration: "PT3M1S" },
        },
      ],
    });

    const out = (await youtubeVideoStatsTool.execute(CTX, {
      video_ids: ["newnewnewne", "oldoldoldol", "longlonglon"],
    })) as { items: Array<Record<string, unknown>> };

    expect(out.items[0]!.short_length).toBe(true);
    expect(out.items[1]!.short_length).toBe(false);
    expect(out.items[2]!.short_length).toBe(false);
  });

  it("rejects anything that is not an 11-character video id", async () => {
    stub({ items: [] });
    await expect(
      youtubeVideoStatsTool.execute(CTX, { video_ids: ["https://youtu.be/abcdefghijk"] }),
    ).rejects.toThrow();
  });
});

describe("youtube_channel_stats", () => {
  it("reports a real negative when the lookup matches nothing", async () => {
    stub({ items: [] });
    const out = (await youtubeChannelStatsTool.execute(CTX, { handle: "nosuchbrand" })) as {
      found: boolean;
      subscriber_count: number | null;
    };
    expect(out.found).toBe(false);
    expect(out.subscriber_count).toBeNull();
  });

  it("normalises a bare handle to @handle and reads the public counts", async () => {
    const calls = stub({
      items: [
        {
          id: "UCzavi",
          snippet: {
            title: "Zavi",
            customUrl: "@zavi",
            description: "d",
            publishedAt: "2024-01-01T00:00:00Z",
          },
          statistics: { subscriberCount: "11", videoCount: "3", viewCount: "900" },
          contentDetails: { relatedPlaylists: { uploads: "UUzavi" } },
        },
      ],
    });
    const out = (await youtubeChannelStatsTool.execute(CTX, { handle: "zavi" })) as {
      found: boolean;
      subscriber_count: number | null;
      uploads_playlist_id: string | null;
    };
    expect(calls[0]!.url).toContain("forHandle=%40zavi");
    expect(out).toMatchObject({ found: true, subscriber_count: 11, uploads_playlist_id: "UUzavi" });
  });

  it("keeps a hidden subscriber count null and flags it", async () => {
    stub({
      items: [
        {
          id: "UCx",
          snippet: { title: "X" },
          statistics: { hiddenSubscriberCount: true, videoCount: "2" },
          contentDetails: {},
        },
      ],
    });
    const out = (await youtubeChannelStatsTool.execute(CTX, { channel_id: "UCx" })) as {
      subscriber_count: number | null;
      subscriber_count_hidden: boolean;
    };
    expect(out.subscriber_count).toBeNull();
    expect(out.subscriber_count_hidden).toBe(true);
  });

  it("requires either a handle or a channel_id", async () => {
    stub({ items: [] });
    await expect(youtubeChannelStatsTool.execute(CTX, {})).rejects.toThrow();
  });
});

describe("failure modes are EXPECTED errors, never crashes or false absences", () => {
  it("a missing API key degrades to an expected error that forbids estimating", async () => {
    delete process.env.YOUTUBE_DATA_API_KEY;
    stub({ items: [] });
    await expect(
      youtubeSearchVideosTool.execute(CTX, { query: "xy" }),
    ).rejects.toMatchObject({ code: "youtube_api_key_missing" });
    await expect(youtubeSearchVideosTool.execute(CTX, { query: "xy" })).rejects.toThrow(
      /do NOT estimate/i,
    );
  });

  it("quota exhaustion says so, and says it is not a finding about the company", async () => {
    stub({}, 403, JSON.stringify({ error: { message: "quotaExceeded" } }));
    const err = await youtubeSearchVideosTool
      .execute(CTX, { query: "xy" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExpectedToolError);
    expect((err as ExpectedToolError).code).toBe("youtube_quota_exceeded");
    expect((err as Error).message).toMatch(/says nothing about the company/i);
  });

  it("a rejected key is distinguished from exhausted quota", async () => {
    stub({}, 403, JSON.stringify({ error: { message: "API key not valid" } }));
    await expect(youtubeSearchVideosTool.execute(CTX, { query: "xy" })).rejects.toMatchObject({
      code: "youtube_api_forbidden",
    });
  });
});

describe("iso8601DurationToSeconds", () => {
  it("parses the shapes YouTube actually returns", () => {
    expect(iso8601DurationToSeconds("PT45S")).toBe(45);
    expect(iso8601DurationToSeconds("PT12M30S")).toBe(750);
    expect(iso8601DurationToSeconds("PT1H2M3S")).toBe(3723);
    expect(iso8601DurationToSeconds("P1DT1H")).toBe(90_000);
    expect(iso8601DurationToSeconds("garbage")).toBeNull();
  });
});

describe("search budget — the 100/day bucket is shared by every customer", () => {
  it("allows exactly MAX_SEARCHES_PER_RUN, then refuses without spending another call", async () => {
    const calls = stub({ items: [] });
    const ctx = { ...CTX, run_id: "run-a" };
    for (let i = 0; i < MAX_SEARCHES_PER_RUN; i++) {
      await youtubeSearchVideosTool.execute(ctx, { query: `q${i}` });
    }
    expect(calls).toHaveLength(MAX_SEARCHES_PER_RUN);

    await expect(
      youtubeSearchVideosTool.execute(ctx, { query: "one too many" }),
    ).rejects.toMatchObject({ code: "youtube_search_budget_exhausted" });
    expect(calls).toHaveLength(MAX_SEARCHES_PER_RUN);
  });

  it("tells the model a budget refusal is not an absence of data", async () => {
    stub({ items: [] });
    const ctx = { ...CTX, run_id: "run-b" };
    for (let i = 0; i < MAX_SEARCHES_PER_RUN; i++) {
      await youtubeSearchVideosTool.execute(ctx, { query: `q${i}` });
    }
    await expect(youtubeSearchVideosTool.execute(ctx, { query: "again" })).rejects.toThrow(
      /do NOT report this as an absence of data/i,
    );
  });

  it("budgets per RUN, not per tenant — one run cannot spend another's", async () => {
    stub({ items: [] });
    for (let i = 0; i < MAX_SEARCHES_PER_RUN; i++) {
      await youtubeSearchVideosTool.execute({ ...CTX, run_id: "run-c" }, { query: `q${i}` });
    }
    await expect(
      youtubeSearchVideosTool.execute({ ...CTX, run_id: "run-d" }, { query: "fresh run" }),
    ).resolves.toBeDefined();
  });

  it("does not meter a call with no run_id — there is no run to attribute it to", async () => {
    stub({ items: [] });
    for (let i = 0; i < MAX_SEARCHES_PER_RUN + 2; i++) {
      await youtubeSearchVideosTool.execute(CTX, { query: `q${i}` });
    }
  });

  it("video_stats and channel_stats are NOT metered — they are 1 unit on the shared pool", async () => {
    stub({ items: [] });
    const ctx = { ...CTX, run_id: "run-e" };
    for (let i = 0; i < MAX_SEARCHES_PER_RUN + 3; i++) {
      await youtubeVideoStatsTool.execute(ctx, { video_ids: ["abcdefghijk"] });
      await youtubeChannelStatsTool.execute(ctx, { channel_id: "UCx" });
    }
  });
});

describe("the thumbnail wall", () => {
  it("returns the thumbnail YouTube is actually showing, preferring the largest", async () => {
    stub({
      items: [
        {
          id: { videoId: "abcdefghijk" },
          snippet: {
            title: "T",
            thumbnails: {
              default: { url: "https://i.ytimg.com/vi/x/default.jpg" },
              high: { url: "https://i.ytimg.com/vi/x/hqdefault.jpg" },
              maxres: { url: "https://i.ytimg.com/vi/x/maxresdefault.jpg" },
            },
          },
        },
      ],
    });
    const out = (await youtubeSearchVideosTool.execute(CTX, { query: "anything" })) as {
      items: Array<{ thumbnail_url: string | null }>;
    };
    expect(out.items[0]!.thumbnail_url).toBe("https://i.ytimg.com/vi/x/maxresdefault.jpg");
  });

  it("falls back down the ladder, and stays null when no thumbnail is offered", async () => {
    stub({
      items: [
        { id: { videoId: "aaaaaaaaaaa" }, snippet: { title: "A", thumbnails: { medium: { url: "m.jpg" } } } },
        { id: { videoId: "bbbbbbbbbbb" }, snippet: { title: "B" } },
      ],
    });
    const out = (await youtubeSearchVideosTool.execute(CTX, { query: "anything" })) as {
      items: Array<{ thumbnail_url: string | null }>;
    };
    expect(out.items[0]!.thumbnail_url).toBe("m.jpg");
    expect(out.items[1]!.thumbnail_url).toBeNull();
  });
});
