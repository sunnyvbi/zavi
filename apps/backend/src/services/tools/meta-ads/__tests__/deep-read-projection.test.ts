
import { describe, it, expect } from "vitest";
import { formatAttributionWindow, formatGenders } from "../list_ad_sets";
import { normalizeCreative, mergeAdDetails, urlTagged } from "../list_ads";

describe("formatAttributionWindow", () => {
  it("renders the real 3-entry spec Meta returned for the probed ad set", () => {
    expect(
      formatAttributionWindow([
        { event_type: "CLICK_THROUGH", window_days: 7 },
        { event_type: "VIEW_THROUGH", window_days: 1 },
        { event_type: "ENGAGED_VIDEO_VIEW", window_days: 1 },
      ]),
    ).toBe("7d click / 1d view / 1d video view");
  });

  it("returns null when absent so the UI shows a dash, not an empty string", () => {
    expect(formatAttributionWindow(null)).toBeNull();
    expect(formatAttributionWindow([])).toBeNull();
  });

  it("does not invent a window from a malformed entry", () => {
    expect(formatAttributionWindow([{ event_type: "CLICK_THROUGH" }])).toBeNull();
    expect(formatAttributionWindow([{ window_days: 7 }])).toBeNull();
  });

  it("title-cases an unknown event type rather than leaking SCREAMING_SNAKE", () => {
    expect(formatAttributionWindow([{ event_type: "SOME_NEW_EVENT", window_days: 3 }])).toBe(
      "3d Some New Event",
    );
  });
});

describe("formatGenders", () => {
  it("maps Meta's integer encoding", () => {
    expect(formatGenders([1])).toBe("Men");
    expect(formatGenders([2])).toBe("Women");
  });

  it("treats absent / both as all genders", () => {
    expect(formatGenders(undefined)).toBe("All genders");
    expect(formatGenders([])).toBe("All genders");
    expect(formatGenders([1, 2])).toBe("All genders");
  });
});

describe("normalizeCreative", () => {
  const realCreative = {
    id: "1000508206301937",
    title: "Rent cars for starting at $39/day",
    body: "Rent cars for starting at $39/day, flexible extentions",
    image_url: "https://scontent-sjc3-1.xx.fbcdn.net/v/t45.1600-4/673538682.jpg?oe=6A5F61C8",
    thumbnail_url: "https://external-sjc6-1.xx.fbcdn.net/emg1/v/t13/17052323690726731634?oe=6A5B7133",
    image_hash: "2f3b36f7e53198937ec40b88bc9c1965",
    call_to_action_type: "SEE_DETAILS",
    object_story_spec: {
      link_data: {
        message: "Rent cars for starting at $39/day, flexible extentions",
        name: "Rent cars for starting at $39/day",
        link: "http://www.upcar.ai/",
        call_to_action: { type: "SEE_DETAILS" },
      },
    },
  };

  it("projects the real probed creative", () => {
    const c = normalizeCreative(realCreative)!;
    expect(c.title).toBe("Rent cars for starting at $39/day");
    expect(c.body).toBe("Rent cars for starting at $39/day, flexible extentions");
    expect(c.call_to_action).toBe("SEE_DETAILS");
    expect(c.destination_url).toBe("http://www.upcar.ai/");
    expect(c.image_hash).toBe("2f3b36f7e53198937ec40b88bc9c1965");
  });

  it("does not flag a plain link ad as dynamic creative", () => {
    const c = normalizeCreative(realCreative)!;
    expect(c.is_dynamic_creative).toBe(false);
    expect(c.variant_count).toBe(1);
  });

  it("returns null for an ad with no creative", () => {
    expect(normalizeCreative(null)).toBeNull();
    expect(normalizeCreative(undefined)).toBeNull();
  });

  it("falls back to object_story_spec when the flat summary is absent", () => {
    const c = normalizeCreative({
      object_story_spec: {
        link_data: {
          message: "body from spec",
          name: "headline from spec",
          link: "https://example.com/x",
          call_to_action: { type: "SHOP_NOW" },
        },
      },
    })!;
    expect(c.body).toBe("body from spec");
    expect(c.title).toBe("headline from spec");
    expect(c.call_to_action).toBe("SHOP_NOW");
    expect(c.destination_url).toBe("https://example.com/x");
  });

  it("reports Advantage+ dynamic creative as 1-of-N rather than as THE ad copy", () => {
    const c = normalizeCreative({
      asset_feed_spec: {
        bodies: [{ text: "body A" }, { text: "body B" }, { text: "body C" }],
        titles: [{ text: "title A" }, { text: "title B" }],
        call_to_action_types: ["LEARN_MORE"],
        link_urls: [{ website_url: "https://example.com/lp" }],
      },
    })!;
    expect(c.is_dynamic_creative).toBe(true);
    expect(c.variant_count).toBe(3);
    expect(c.body).toBe("body A");
    expect(c.destination_url).toBe("https://example.com/lp");
  });

  it("counts link-only rotation as dynamic", () => {
    const c = normalizeCreative({
      body: "one body",
      asset_feed_spec: { link_urls: [{ website_url: "https://example.com/a" }, { website_url: "https://example.com/b" }] },
    })!;
    expect(c.is_dynamic_creative).toBe(true);
    expect(c.variant_count).toBe(2);
  });

  it("survives an empty creative object without throwing", () => {
    const c = normalizeCreative({})!;
    expect(c.body).toBeNull();
    expect(c.title).toBeNull();
    expect(c.is_dynamic_creative).toBe(false);
  });
});

describe("mergeAdDetails creative gating", () => {
  const rows = [{ ad_id: "1", ad_name: "Ad One", spend: "10", impressions: "100" }];
  const details = { "1": { effective_status: "ACTIVE", creative: { title: "T" } } };

  it("omits the creative key entirely when not requested", () => {
    const [ad] = mergeAdDetails(rows, details, false);
    expect(ad).not.toHaveProperty("creative");
  });

  it("includes creative when requested", () => {
    const [ad] = mergeAdDetails(rows, details, true);
    expect(ad).toHaveProperty("creative");
    expect((ad.creative as Record<string, unknown>).title).toBe("T");
  });

  it("includes an explicit null when asked but the ad has no creative", () => {
    const [ad] = mergeAdDetails(rows, { "1": { effective_status: "ACTIVE" } }, true);
    expect(ad).toHaveProperty("creative");
    expect(ad.creative).toBeNull();
  });

  it("defaults to omitting creative so existing callers are unchanged", () => {
    const [ad] = mergeAdDetails(rows, details);
    expect(ad).not.toHaveProperty("creative");
  });
});

describe("url tags on live ads", () => {
  const rows = [{ ad_id: "1", ad_name: "Spring promo", spend: "10" }];

  it("every ad says whether its clicks carry tracking parameters, even without the creative", () => {
    const [tagged] = mergeAdDetails(rows, { "1": { effective_status: "ACTIVE", creative: { url_tags: "utm_source=meta&utm_campaign=spring" } } });
    expect(tagged).toMatchObject({ url_tags: "utm_source=meta&utm_campaign=spring", url_tagged: true });
    const [bare] = mergeAdDetails(rows, { "1": { effective_status: "ACTIVE", creative: { link_url: "https://shop.example/menu" } } });
    expect(bare).toMatchObject({ url_tags: null, url_tagged: false });
  });

  it("a link that already carries utm_ counts as tagged; no creative or no link is unknown, never untagged", () => {
    expect(urlTagged({ object_story_spec: { link_data: { link: "https://studio.example/?utm_source=fb" } } })).toBe(true);
    expect(urlTagged({ asset_feed_spec: { link_urls: [{ website_url: "https://a.example/?utm_medium=paid" }, { website_url: "https://a.example/" }] } })).toBe(false);
    expect(urlTagged(null)).toBeNull();
    expect(urlTagged({})).toBeNull();
  });
});
