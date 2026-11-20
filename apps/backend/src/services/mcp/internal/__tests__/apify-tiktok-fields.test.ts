
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { callApifyTool } from "../apify";

const TENANT = "00000000-0000-0000-0000-000000000000";

async function call(args: Record<string, unknown>): Promise<any> {
  const r = await callApifyTool(TENANT, "scrape_tiktok", args);
  return { ...r, parsed: JSON.parse(r.content) };
}

const AUTHOR = {
  name: "turo",
  nickName: "Turo",
  signature: "Rental reinvented.",
  bioLink: "bit.ly/m/turo",
  fans: 17000,
  following: 15,
  heart: 115500,
  video: 163,
  verified: true,
  privateAccount: false,
};

const REAL_TIKTOK_PAYLOAD = [
  {
    text: "Cars are cool. Rental cars are not cool.",
    playCount: 3780,
    diggCount: 65,
    commentCount: 6,
    collectCount: 34,
    shareCount: 18,
    createTimeISO: "2026-03-16T17:00:33.000Z",
    isAd: true,
    isPinned: true,
    isSlideshow: false,
    hashtags: [],
    authorMeta: AUTHOR,
    videoMeta: {
      duration: 60,
      width: 720,
      height: 1280,
      coverUrl: "https://p16.example/cover0.jpg",
      subtitleLinks: [{ language: "eng-US", downloadLink: "https://v16.example/sub0.vtt" }],
    },
    musicMeta: { musicName: "original sound", musicAuthor: "Turo", musicOriginal: true },
  },
  {
    text: "Rent a car. Not a rental car.",
    playCount: 786900,
    diggCount: 900,
    commentCount: 40,
    collectCount: 150,
    shareCount: 27,
    createTimeISO: "2026-03-19T17:00:00.000Z",
    isAd: true,
    isPinned: true,
    isSlideshow: true,
    hashtags: [],
    authorMeta: AUTHOR,
    videoMeta: { duration: 0, coverUrl: "https://p16.example/cover1.jpg", subtitleLinks: [] },
    musicMeta: { musicName: "Some Licensed Track", musicAuthor: "An Artist", musicOriginal: false },
  },
  {
    text: "the car you actually wanted",
    playCount: 99,
    diggCount: 3,
    commentCount: 0,
    collectCount: 0,
    shareCount: 1,
    createTimeISO: "2026-09-04T15:00:00.000Z",
    isAd: false,
    isPinned: false,
    isSlideshow: false,
    hashtags: [{ name: "carrental" }, { name: "roadtrip" }],
    textLanguage: "en",
    authorMeta: AUTHOR,
    videoMeta: { duration: 82, width: 1080, height: 1920, subtitleLinks: [] },
    musicMeta: { musicName: "original sound", musicAuthor: "Turo", musicOriginal: true },
  },
  {
    text: "seven second version",
    playCount: 502,
    diggCount: 12,
    commentCount: 1,
    collectCount: 1,
    shareCount: 0,
    createTimeISO: "2026-08-26T15:00:00.000Z",
    isAd: false,
    isPinned: false,
    isSlideshow: false,
    hashtags: [],
    authorMeta: AUTHOR,
    videoMeta: { duration: 7, width: 1080, height: 1920, subtitleLinks: [] },
    musicMeta: { musicName: "A Licensed Track", musicAuthor: "Artist", musicOriginal: false },
  },
  {
    text: "middle of the pack",
    playCount: 307,
    diggCount: 8,
    commentCount: 0,
    collectCount: 0,
    shareCount: 1,
    createTimeISO: "2026-09-02T15:00:00.000Z",
    isAd: false,
    isPinned: false,
    isSlideshow: false,
    hashtags: [],
    authorMeta: AUTHOR,
    videoMeta: { duration: 77, width: 1080, height: 1920, subtitleLinks: [] },
    musicMeta: { musicName: "original sound", musicAuthor: "Turo", musicOriginal: true },
  },
];

function fakeApify(capture: { body?: any }) {
  return (async (_url: string | URL, init?: RequestInit) => {
    capture.body = JSON.parse(String(init?.body ?? "{}"));
    return new Response(JSON.stringify(REAL_TIKTOK_PAYLOAD), {
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
    });
  }) as typeof fetch;
}

describe("scrape_tiktok: mapped fields", () => {
  let prevToken: string | undefined;
  beforeEach(() => {
    prevToken = process.env.APIFY_TOKEN;
    process.env.APIFY_TOKEN = "test-token";
  });
  afterEach(() => {
    if (prevToken === undefined) delete process.env.APIFY_TOKEN;
    else process.env.APIFY_TOKEN = prevToken;
    vi.restoreAllMocks();
  });

  it("still rejects hashtag+username together", async () => {
    vi.stubGlobal("fetch", fakeApify({}));
    const r = await call({ hashtag: "carrental", username: "turo" });
    expect(r.ok).toBe(false);
    expect(r.parsed).toMatchObject({ error: "tool_input_invalid" });
  });

  it("excludes promoted and pinned posts from organic_window", async () => {
    vi.stubGlobal("fetch", fakeApify({}));
    const r = await call({ username: "turo", max_items: 20 });

    expect(r.parsed.organic_window).toEqual({
      returned: 5,
      organic: 3,
      excluded_ads_or_pinned: 2,
      median_basis: 3,
      median_plays_organic: 307,
      min_plays_organic: 99,
      max_plays_organic: 502,
    });
  });

  it("keeps the ad/pinned items in `items` and flags them, rather than hiding them", async () => {
    vi.stubGlobal("fetch", fakeApify({}));
    const r = await call({ username: "turo" });
    expect(r.parsed.items).toHaveLength(5);
    expect(r.parsed.items[0]).toMatchObject({ is_ad: true, is_pinned: true });
    expect(r.parsed.items[2]).toMatchObject({ is_ad: false, is_pinned: false });
  });

  it("exposes the four fields the capsule wrongly called unreadable", async () => {
    vi.stubGlobal("fetch", fakeApify({}));
    const r = await call({ username: "turo" });

    expect(r.parsed.items[0]).toMatchObject({ saves: 34, shares: 18 });
    expect(r.parsed.profile).toMatchObject({
      username: "turo",
      followers: 17000,
      total_likes: 115500,
      videos_total: 163,
      is_verified: true,
      bio_link: "bit.ly/m/turo",
    });
    expect(r.parsed.items[0].subtitle_url).toBe("https://v16.example/sub0.vtt");
    expect(r.parsed.items[0].subtitle_languages).toEqual(["eng-US"]);
  });

  it("maps format fields so 'which format works' is a performable check", async () => {
    vi.stubGlobal("fetch", fakeApify({}));
    const r = await call({ username: "turo" });

    expect(r.parsed.items[2]).toMatchObject({
      duration_seconds: 82,
      is_slideshow: false,
      aspect_ratio: 0.563,
      sound_is_original: true,
      hashtags: ["carrental", "roadtrip"],
      text_language: "en",
    });
    expect(r.parsed.items[1]).toMatchObject({ is_slideshow: true, duration_seconds: 0 });
    expect(r.parsed.items[1].sound_is_original).toBe(false);
  });

  it("omits the profile block on a hashtag query, where authors differ per item", async () => {
    vi.stubGlobal("fetch", fakeApify({}));
    const r = await call({ hashtag: "carrental" });
    expect(r.parsed.profile).toBeUndefined();
    expect(r.parsed.organic_window.organic).toBe(3);
  });

  it("keeps the profile block inside the truncator's 512-byte sibling budget", async () => {
    const longBio = [...REAL_TIKTOK_PAYLOAD];
    longBio[0] = {
      ...longBio[0],
      authorMeta: { ...AUTHOR, signature: "x".repeat(2000) },
    } as any;
    vi.stubGlobal("fetch", (async () =>
      new Response(JSON.stringify(longBio), {
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
      })) as typeof fetch);
    const r = await call({ username: "turo" });
    const size = Buffer.byteLength(JSON.stringify(r.parsed.profile));
    expect(size).toBeLessThanOrEqual(512);
    expect(r.parsed.profile.followers).toBe(17000);
    expect(r.parsed.profile.bio_link).toBe("bit.ly/m/turo");
  });

  it("does not ship cover_url — nothing reads it and it was 25% of the payload", async () => {
    vi.stubGlobal("fetch", fakeApify({}));
    const r = await call({ username: "turo" });
    expect(r.parsed.items[0]).not.toHaveProperty("cover_url");
  });
});

describe("scrape_tiktok: all-empty items are could-not-verify (2026-09-17)", () => {
  let prevToken: string | undefined;
  beforeEach(() => {
    prevToken = process.env.APIFY_TOKEN;
    process.env.APIFY_TOKEN = "test-token";
  });
  afterEach(() => {
    if (prevToken === undefined) delete process.env.APIFY_TOKEN;
    else process.env.APIFY_TOKEN = prevToken;
    vi.restoreAllMocks();
  });

  it("items with every field empty are not counted as videos", async () => {
    const empties = [{ text: "" }, { text: "" }];
    vi.stubGlobal("fetch", (async () =>
      new Response(JSON.stringify(empties), { status: 200, headers: new Headers({ "content-type": "application/json" }) })) as typeof fetch);
    const r = await call({ username: "examplebrand" });
    expect(r.ok).toBe(false);
    expect(r.parsed.error).toBe("tool_no_data");
    expect(r.parsed.message).toMatch(/could not verify/);
  });
});
