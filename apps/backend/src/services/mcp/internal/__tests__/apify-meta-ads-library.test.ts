
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { callApifyTool } from "../apify";

const TENANT = "00000000-0000-0000-0000-000000000000";

async function call(args: Record<string, unknown>): Promise<any> {
  const r = await callApifyTool(TENANT, "scrape_meta_ads", args);
  return { ...r, parsed: JSON.parse(r.content) };
}

const START = new Date(Date.now() - 400 * 86_400_000).toISOString();

const REAL_AD_PAYLOAD = [
  {
    adArchiveID: "1229350099285014",
    pageID: "16453004404",
    isActive: true,
    collationCount: 7,
    publisherPlatform: ["FACEBOOK", "INSTAGRAM"],
    startDateFormatted: START,
    endDateFormatted: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    snapshot: {
      pageName: "Sephora",
      pageProfileUri: "https://www.facebook.com/sephora/",
      title: "Our App = Your Beauty BFF",
      body: { text: "Major beauty benefits are waiting for you on the app 💞" },
      caption: "sephora.com",
      linkDescription: "Download now",
      linkUrl: "https://www.sephora.com/beauty/app",
      ctaText: "Download",
      displayFormat: "DCO",
      images: [],
      videos: [{ videoPreviewImageUrl: "https://scontent.xx.fbcdn.net/preview.jpg" }],
      cards: [
        { title: "Card one", body: "Card one body", ctaText: "Download", linkUrl: "https://x.test/1" },
        { title: "Card two", body: "Card two body", ctaText: "Download", linkUrl: "https://x.test/2" },
        { title: "Card three", body: "Card three body", ctaText: "Download", linkUrl: "https://x.test/3" },
        { title: "Card four", body: "Card four body", ctaText: "Download", linkUrl: "https://x.test/4" },
      ],
    },
  },
];

function fakeApify(capture: { body?: any }, items: unknown[] = REAL_AD_PAYLOAD) {
  return (async (_url: string | URL, init?: RequestInit) => {
    capture.body = JSON.parse(String(init?.body ?? "{}"));
    return new Response(JSON.stringify(items), {
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
    });
  }) as typeof fetch;
}

describe("apify scrape_meta_ads", () => {
  let prevToken: string | undefined;
  beforeEach(() => {
    prevToken = process.env.APIFY_TOKEN;
    process.env.APIFY_TOKEN = "test-token";
  });
  afterEach(() => {
    if (prevToken === undefined) delete process.env.APIFY_TOKEN;
    else process.env.APIFY_TOKEN = prevToken;
    vi.unstubAllGlobals();
  });

  it("reads the ad's pitch out of the object-shaped body, not [object Object]", async () => {
    vi.stubGlobal("fetch", fakeApify({}));
    const { parsed } = await call({ query: "sephora" });
    const ad = parsed.ads[0];
    expect(ad.body).toBe("Major beauty benefits are waiting for you on the app 💞");
    expect(ad.headline).toBe("Our App = Your Beauty BFF");
    expect(ad.cta).toBe("Download");
    expect(ad.media_url).toBe("https://scontent.xx.fbcdn.net/preview.jpg");
    expect(ad.cards).toHaveLength(3);
    expect(ad.cards[0].body).toBe("Card one body");
    expect(ad.variants).toBe(7);
  });

  it("builds a keyword Ad Library URL for a query", async () => {
    const cap: { body?: any } = {};
    vi.stubGlobal("fetch", fakeApify(cap));
    await call({ query: "car rental", country: "in", active_status: "all", max_items: 5 });
    const url: string = cap.body.startUrls[0].url;
    expect(url).toContain("https://www.facebook.com/ads/library/?");
    expect(url).toContain("q=car+rental");
    expect(url).toContain("country=IN");
    expect(url).toContain("active_status=all");
    expect(cap.body.resultsLimit).toBe(5);
  });

  it("passes a facebook Page URL straight through", async () => {
    const cap: { body?: any } = {};
    vi.stubGlobal("fetch", fakeApify(cap));
    await call({ page_url: "https://www.facebook.com/sephora/" });
    expect(cap.body.startUrls[0].url).toBe("https://www.facebook.com/sephora/");
  });

  it("refuses a non-facebook page_url — the actor is paid, and the host is the pin", async () => {
    vi.stubGlobal("fetch", fakeApify({}));
    const r = await call({ page_url: "https://evil.test/ads/library/" });
    expect(r.is_error).toBe(true);
    expect(r.parsed.error).toBe("tool_input_invalid");
  });

  it("refuses both, and neither, of page_url and query", async () => {
    vi.stubGlobal("fetch", fakeApify({}));
    for (const args of [{}, { page_url: "https://www.facebook.com/sephora/", query: "sephora" }]) {
      const r = await call(args);
      expect(r.is_error).toBe(true);
      expect(r.parsed.error).toBe("tool_input_invalid");
    }
  });

  it("drops a DCO ad's {{product.name}} placeholders but keeps the real copy in its cards", async () => {
    const dco = [
      {
        ...REAL_AD_PAYLOAD[0],
        snapshot: {
          ...REAL_AD_PAYLOAD[0].snapshot,
          title: "{{product.name}}",
          body: { text: "{{product.brand}}" },
          linkDescription: "{{product.description}}",
        },
      },
    ];
    vi.stubGlobal("fetch", fakeApify({}, dco));
    const ad = (await call({ query: "anything" })).parsed.ads[0];
    expect(ad.headline).toBeNull();
    expect(ad.body).toBeNull();
    expect(ad.link_description).toBeNull();
    expect(ad.cards[0].title).toBe("Card one");
    expect(ad.format).toBe("DCO");
  });

  it("raises on an empty library rather than returning [] — no ads found is not 'they run no ads'", async () => {
    vi.stubGlobal("fetch", fakeApify({}, []));
    const r = await call({ query: "nobody-advertises-this" });
    expect(r.is_error).toBe(true);
    expect(r.parsed.error).toBe("tool_no_data");
    expect(r.parsed.message).toContain("NOT proof");
  });
});
