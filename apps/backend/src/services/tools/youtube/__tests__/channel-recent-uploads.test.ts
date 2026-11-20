
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { youtubeChannelStatsTool } from "../channel_stats";
import { describeTool } from "@zavi/shared";

const CTX = { tenant_id: "t-1", log: () => {} };
const CHANNEL = {
  items: [{
    id: "UCdoug",
    snippet: { title: "Doug DeMuro", customUrl: "@dougdemuro" },
    statistics: { subscriberCount: "5100000", videoCount: "1500", viewCount: "3000000000" },
    contentDetails: { relatedPlaylists: { uploads: "UUdoug" } },
  }],
};
const UPLOADS = {
  items: [
    { snippet: { title: "Buick Roadmaster", publishedAt: "2026-10-22T15:00:00Z" }, contentDetails: { videoId: "v1", videoPublishedAt: "2026-10-22T14:00:00Z" } },
    { snippet: { title: "Acura NSX", resourceId: { videoId: "v2" } }, contentDetails: { videoPublishedAt: "2026-10-20T14:00:00Z" } },
    { snippet: { title: "no id" }, contentDetails: {} },
  ],
};

let urls: string[] = [];
function route(playlist: { status: number; body: unknown }) {
  urls = [];
  vi.stubGlobal("fetch", vi.fn(async (u: string | URL) => {
    const url = String(u);
    urls.push(url);
    const isPl = url.includes("/playlistItems");
    const status = isPl ? playlist.status : 200;
    const body = isPl ? playlist.body : CHANNEL;
    return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
  }));
}

beforeEach(() => { process.env.YOUTUBE_DATA_API_KEY = "test-key"; });
afterEach(() => { vi.unstubAllGlobals(); delete process.env.YOUTUBE_DATA_API_KEY; });

describe("youtube_channel_stats recent_uploads", () => {
  it("lists the newest uploads from the uploads playlist, newest first, by video publish date", async () => {
    route({ status: 200, body: UPLOADS });
    const out = (await youtubeChannelStatsTool.execute(CTX, { handle: "dougdemuro", recent_uploads: 3 })) as {
      subscriber_count: number; recent_uploads: { video_id: string; title: string; published_at: string }[]; recent_uploads_error: string | null;
    };
    expect(out.subscriber_count).toBe(5_100_000);
    expect(out.recent_uploads).toEqual([
      { video_id: "v1", title: "Buick Roadmaster", published_at: "2026-10-22T14:00:00Z" },
      { video_id: "v2", title: "Acura NSX", published_at: "2026-10-20T14:00:00Z" },
    ]);
    const pl = new URL(urls.find((u) => u.includes("/playlistItems"))!);
    expect(pl.searchParams.get("playlistId")).toBe("UUdoug");
    expect(pl.searchParams.get("maxResults")).toBe("3");
    expect(urls.some((u) => u.includes("/search"))).toBe(false);
  });

  it("a failed uploads read keeps the channel facts and says why", async () => {
    route({ status: 500, body: { error: "backend" } });
    const out = (await youtubeChannelStatsTool.execute(CTX, { handle: "dougdemuro" })) as {
      subscriber_count: number; recent_uploads: unknown[]; recent_uploads_error: string | null;
    };
    expect(out.subscriber_count).toBe(5_100_000);
    expect(out.recent_uploads).toEqual([]);
    expect(out.recent_uploads_error).toMatch(/500/);
  });

  it("recent_uploads: 0 skips the extra call", async () => {
    route({ status: 200, body: UPLOADS });
    await youtubeChannelStatsTool.execute(CTX, { handle: "dougdemuro", recent_uploads: 0 });
    expect(urls.some((u) => u.includes("/playlistItems"))).toBe(false);
  });
});

describe("step label for social reads", () => {
  it("a YouTube or social READ is not 'Worked on a social post'", () => {
    expect(describeTool("mcp__server__composio__YOUTUBE_LIST_CHANNEL_VIDEOS")).toBe("Looked at social media data");
    expect(describeTool("mcp__server__youtube__channel_stats")).toBe("Looked at social media data");
    expect(describeTool("x_social__read_post_metrics")).toBe("Looked at social media data");
  });
  it("a real post action keeps its label", () => {
    expect(describeTool("social__publish_post")).toBe("Worked on a social post");
    expect(describeTool("composio__YOUTUBE_UPLOAD_VIDEO")).toBe("Worked on a social post");
  });
});
