
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { callApifyTool } from "../apify";

const TENANT = "00000000-0000-0000-0000-000000000000";

async function call(args: Record<string, unknown>): Promise<any> {
  const r = await callApifyTool(TENANT, "scrape_instagram", args);
  return { ...r, parsed: JSON.parse(r.content) };
}

const REAL_DETAILS_PAYLOAD = [
  {
    username: "turo",
    fullName: "Turo",
    biography: "Rental reinvented.\nRent the exact car you want",
    followersCount: 302110,
    followsCount: 906,
    postsCount: 1531,
    isBusinessAccount: true,
    businessCategoryName: null,
    private: false,
    verified: true,
    externalUrl: "http://www.bit.ly/m/turo",
    externalUrls: [{ link_type: "external" }],
    latestPosts: [
      {
        type: "Video",
        productType: "clips",
        caption: "POV: You receive a round trip ticket",
        likesCount: 34,
        commentsCount: 6,
        videoViewCount: 505,
        timestamp: "2026-09-04T12:00:00.000Z",
        hashtags: [],
        dimensionsWidth: 1080,
        dimensionsHeight: 1920,
        alt: "Photo by Turo on September 04, 2026.",
        url: "https://www.instagram.com/p/aaa/",
      },
      {
        type: "Sidecar",
        productType: "carousel_container",
        caption: "Sometimes you gotta state the obvious.",
        likesCount: 243,
        commentsCount: 188,
        timestamp: "2026-03-19T12:00:00.000Z",
        hashtags: ["carrental", "roadtrip"],
        dimensionsWidth: 1080,
        dimensionsHeight: 1350,
        childPosts: [{}, {}, {}, {}],
        isCommentsDisabled: false,
        alt: "A hand-written alt description of the carousel cover.",
        url: "https://www.instagram.com/p/bbb/",
      },
    ],
  },
];

function fakeApify(capture: { body?: unknown }) {
  return (async (_url: string | URL, init?: RequestInit) => {
    capture.body = JSON.parse(String(init?.body ?? "{}"));
    return new Response(JSON.stringify(REAL_DETAILS_PAYLOAD), {
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
    });
  }) as typeof fetch;
}

describe("scrape_instagram: details", () => {
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

  it("passes resultsType 'details' through to the actor, unmapped", async () => {
    const cap: { body?: unknown } = {};
    vi.stubGlobal("fetch", fakeApify(cap));
    await call({ username: "turo", result_type: "details", max_items: 12 });
    expect(cap.body).toMatchObject({
      directUrls: ["https://www.instagram.com/turo/"],
      resultsType: "details",
    });
  });

  it("returns the profile block the channel's eligibility step depends on", async () => {
    vi.stubGlobal("fetch", fakeApify({}));
    const r = await call({ username: "turo", result_type: "details" });

    expect(r.parsed.profile).toMatchObject({
      username: "turo",
      full_name: "Turo",
      followers: 302110,
      follows: 906,
      posts_total: 1531,
      is_business_account: true,
      is_private: false,
      is_verified: true,
      external_url: "http://www.bit.ly/m/turo",
    });
  });

  it("maps format, public counts and craft signals per post", async () => {
    vi.stubGlobal("fetch", fakeApify({}));
    const r = await call({ username: "turo", result_type: "details" });

    const [reel, carousel] = r.parsed.recent_posts as Record<string, unknown>[];

    expect(reel).toMatchObject({
      type: "Video",
      product_type: "clips",
      likes: 34,
      comments: 6,
      views: 505,
      aspect_ratio: 0.563,
      hashtag_count: 0,
      has_written_alt: false,
    });

    expect(carousel).toMatchObject({
      product_type: "carousel_container",
      carousel_slides: 4,
      hashtag_count: 2,
      aspect_ratio: 0.8,
      comments_disabled: false,
      has_written_alt: true,
      views: null,
    });

    expect(r.parsed.recent_posts_window).toBe(2);
  });

  it("does not leak the actor's raw nested payload into the tool result", async () => {
    vi.stubGlobal("fetch", fakeApify({}));
    const r = await call({ username: "turo", result_type: "details" });

    for (const p of r.parsed.recent_posts as Record<string, unknown>[]) {
      expect(p).not.toHaveProperty("childPosts");
      expect(p).not.toHaveProperty("latestComments");
      expect(p).not.toHaveProperty("images");
    }
  });

  it("fails loudly when the handle resolves to nothing", async () => {
    vi.stubGlobal("fetch", (async () =>
      new Response(JSON.stringify([{ error: "no_items" }]), {
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
      })) as typeof fetch);

    const r = await call({
      username: "definitely-not-a-real-handle",
      result_type: "details",
    });

    expect(r.is_error).toBe(true);
    expect(r.parsed.error).toBe("tool_no_data");
  });
});

describe("scrape_instagram: an empty shell is could-not-verify, not a profile (2026-09-17)", () => {
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

  it("a username echoed back with every field null returns tool_no_data saying could not verify", async () => {
    const shell = [{ username: "examplebrand", fullName: null, biography: "", followersCount: null, postsCount: null, latestPosts: [] }];
    vi.stubGlobal("fetch", (async () =>
      new Response(JSON.stringify(shell), { status: 200, headers: new Headers({ "content-type": "application/json" }) })) as typeof fetch);
    const r = await call({ username: "examplebrand", result_type: "details" });
    expect(r.ok).toBe(false);
    expect(r.parsed.error).toBe("tool_no_data");
    expect(r.parsed.message).toMatch(/could not verify/);
  });
});
