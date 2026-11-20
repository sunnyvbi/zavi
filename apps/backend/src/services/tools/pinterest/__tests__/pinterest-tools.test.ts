import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/services/tools/growth/seo/run", () => ({ resolveTenantSite: vi.fn() }));
vi.mock("@/services/onboarding/enrichment/discover", () => ({ safeFetchText: vi.fn() }));

import { resolveTenantSite } from "@/services/tools/growth/seo/run";
import { safeFetchText } from "@/services/onboarding/enrichment/discover";
import { pinterestPublicPinsTool, pinterestUsername, summarise } from "../public_pins";
import { pinterestSiteReadinessTool, checkPage, pinterestProfileLinks } from "../site_readiness";
import { smartTruncateToolResult, toolResultCapBytes } from "@/services/agents/smart-truncate";

const ctx = { tenant_id: "00000000-0000-0000-0000-000000000001" } as never;

function pin(i: number, saves: number, domain = "shop.example", w = 1000, h = 1500) {
  return {
    id: `10000${i}`,
    description: `Linen table runner in sage, handmade, pin ${i}`,
    link: `https://${domain}/products/runner-${i}?utm_source=pinterest&amp;utm_medium=social`,
    domain,
    repin_count: 1,
    is_video: i % 5 === 0,
    board: { name: "Table settings", follower_count: 900 },
    aggregated_pin_data: { aggregated_stats: { saves } },
    images: { orig: { width: w, height: h } },
  };
}

describe("pinterestUsername", () => {
  it("accepts a bare name, @name, and a profile URL", () => {
    expect(pinterestUsername("acmehome")).toBe("acmehome");
    expect(pinterestUsername(" @acmehome ")).toBe("acmehome");
    expect(pinterestUsername("https://www.pinterest.com/acmehome/")).toBe("acmehome");
    expect(pinterestUsername("https://uk.pinterest.co.uk/acmehome/boards/")).toBe("acmehome");
  });
});

describe("summarise", () => {
  it("computes the headline over EVERY pin before max_pins trims the list", () => {
    const pins = [pin(1, 40), pin(2, 2), pin(3, 10, "other.example", 1000, 1000), pin(4, 7)];
    const out = summarise("acme", null, { follower_count: 1200, pin_count: 300 }, pins, 2);
    expect(out.pins).toHaveLength(2);
    expect(out.summary.pins_read).toBe(4);
    expect(out.summary.median_saves).toBe(8.5);
    expect(out.summary.max_saves).toBe(40);
    expect(out.summary.link_domains).toEqual({ "shop.example": 3, "other.example": 1 });
    expect(out.summary.image_aspects).toEqual({ "2:3": 3, "1:1": 1 });
    expect(out.summary.top_by_saves[0].saves).toBe(40);
    expect(out.profile?.followers).toBe(1200);
    expect(out.pins[0].link).toContain("&utm_medium=social");
  });
});

describe("pinterest_public_pins", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("reads the public widget for a user and refuses a path-smuggling username", async () => {
    const body = { status: "success", data: { user: { follower_count: 50 }, pins: [pin(1, 3), pin(2, 9)] } };
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    global.fetch = f as never;
    const out = (await pinterestPublicPinsTool.execute(ctx, { username: "@acme_home" })) as ReturnType<typeof summarise>;
    expect(f.mock.calls[0][0]).toBe("https://widgets.pinterest.com/v3/pidgets/users/acme_home/pins/");
    expect(out.summary.pins_read).toBe(2);
    await expect(pinterestPublicPinsTool.execute(ctx, { username: "acme/../x" })).rejects.toMatchObject({
      code: "tool_input_invalid",
    });
  });

  it.each([
    "https://www.pinterest.com/pin/123/",
    "https://www.pinterest.com/search/pins/?q=x",
    "https://www.pinterest.com/ideas/",
    "https://www.pinterest.com/PIN/123/",
    "https://www.pinterest.com/_/",
  ])("refuses %s as an account and never fetches", async (raw) => {
    const body = { status: "success", data: { user: { follower_count: 50 }, pins: [pin(1, 3)] } };
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    global.fetch = f as never;
    await expect(pinterestPublicPinsTool.execute(ctx, { username: raw })).rejects.toMatchObject({
      code: "tool_input_invalid",
      message: expect.stringContaining("profile URL"),
    });
    expect(f).not.toHaveBeenCalled();
  });

  it("an unreachable or empty widget is loud, never an empty 'no pins'", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 503 })) as never;
    await expect(pinterestPublicPinsTool.execute(ctx, { username: "acme" })).rejects.toMatchObject({
      code: "pinterest_public_unavailable",
    });
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ status: "success", data: { pins: [] } }), { status: 200 })) as never;
    await expect(pinterestPublicPinsTool.execute(ctx, { username: "acme" })).rejects.toMatchObject({
      code: "tool_no_data",
    });
  });

  it("a full 50-pin read fits its truncation cap whole", () => {
    const pins = Array.from({ length: 50 }, (_, i) => pin(i, i * 3));
    const out = summarise("acme", null, { follower_count: 1, about: "x".repeat(300) }, pins, 50);
    const json = JSON.stringify(out);
    const cap = toolResultCapBytes("pinterest", "public_pins");
    expect(cap).toBeGreaterThan(2048);
    const cut = smartTruncateToolResult(json, cap);
    expect(cut).toContain("median_saves");
  });
});

const PRODUCT_PAGE = `<!doctype html><html><head>
<meta property="og:title" content="Sage linen table runner">
<meta property="og:description" content="Handmade in small batches.">
<meta property="og:image" content="https://shop.example/runner.jpg">
<meta property="og:type" content="product">
<meta name="pinterest" content="nopin">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Product","name":"Runner","offers":{"@type":"Offer","price":"48.00","priceCurrency":"USD","availability":"https://schema.org/InStock"}}]}</script>
<script src="https://cdn.shopify.com/s/files/theme.js"></script>
</head><body><a href="https://www.pinterest.com/shopexample/">Pinterest</a>
<a href="https://www.pinterest.com/pin/123/">a pin</a></body></html>`;

describe("checkPage", () => {
  it("reads Rich Pin fields from JSON-LD, finds the nopin blocker and the profile link", () => {
    const r = checkPage("https://shop.example/products/runner", PRODUCT_PAGE, false);
    expect(r.kind).toBe("product");
    expect(r.product).toMatchObject({ source: "json_ld", price: "48.00", currency: "USD", availability: "InStock" });
    expect(r.rich_pin).toEqual({ ready: true, missing: [] });
    expect(r.save_blockers).toHaveLength(1);
    expect(r.pinterest_profile_links).toEqual(["shopexample"]);
    expect(r.shopify).toBe(true);
    expect(r.pinterest_tag).toBe(false);
    expect(r.domain_verify_tag).toBe(false);
  });

  it("says what each gap costs a pin, blockers first", () => {
    const blocked = checkPage("https://shop.example/products/runner", PRODUCT_PAGE, false);
    expect(blocked.impact).toEqual(["Nobody can save this page to Pinterest."]);
    const html = `<meta property="og:type" content="product"><meta property="og:title" content="X">`;
    const r = checkPage("https://shop.example/p", html, false);
    expect(r.impact).toEqual(
      expect.arrayContaining([
        "A pin saved from this page shows no image or the wrong one.",
        "A pin saved from this page shows no description.",
        "A Rich Pin of this product shows no price.",
      ]),
    );
    expect(r.impact).toHaveLength(r.rich_pin.missing.length);
  });

  it("lists real same-site paths, product pages first", () => {
    const html = `<a href="/about">a</a><a href="https://shop.example/products/mug?v=1">m</a><a href="https://elsewhere.example/x">x</a>`;
    expect(checkPage("https://shop.example/", html, false).same_site_links).toEqual(["/products/mug", "/about"]);
  });

  it("names exactly what a product page is missing", () => {
    const html = `<meta property="og:type" content="product"><meta property="og:title" content="X">`;
    const r = checkPage("https://shop.example/p", html, false);
    expect(r.rich_pin.ready).toBe(false);
    expect(r.rich_pin.missing).toEqual(
      expect.arrayContaining(["og:description", "og:image", expect.stringMatching(/^price/), expect.stringMatching(/^currency/)]),
    );
  });

  it("sees the tag, the claim meta and the Save button in raw HTML", () => {
    const html = `<meta name="p:domain_verify" content="abc"><script>!function(e){pintrk('load','1')}</script><script src="//s.pinimg.com/ct/core.js"></script><a data-pin-do="buttonBookmark"></a>`;
    const r = checkPage("https://shop.example/", html, false);
    expect(r.pinterest_tag).toBe(true);
    expect(r.domain_verify_tag).toBe(true);
    expect(r.save_button).toBe(true);
    expect(r.kind).toBe("page");
  });

  it("a product URL with no product markup is a product page missing its price (live: a Shopify store, 2026-09-24)", () => {
    const html = `<meta property="og:type" content="website"><meta property="og:title" content="Men&#39;s Runners"><meta property="og:description" content="d"><meta property="og:image" content="i">`;
    const r = checkPage("https://shop.example/products/runner", html, false);
    expect(r.kind).toBe("product");
    expect(r.og.title).toBe("Men's Runners");
    expect(r.rich_pin.ready).toBe(false);
    expect(r.rich_pin.missing.some((m) => m.startsWith("price"))).toBe(true);
  });

  it("reads the price off a Shopify ProductGroup's first variant", () => {
    const html = `<script type="application/ld+json">{"@type":"ProductGroup","hasVariant":[{"@type":"Product","offers":{"price":"30.00","priceCurrency":"USD","availability":"http://schema.org/InStock"}}]}</script>`;
    const r = checkPage("https://shop.example/products/mug", html, false);
    expect(r.product).toMatchObject({ source: "json_ld", price: "30.00", currency: "USD", availability: "InStock" });
  });

  it("on a truncated page, not seeing a tag is 'could not verify', never 'missing'", () => {
    const r = checkPage("https://shop.example/", `<meta property="og:title" content="x">`, true);
    expect(r.pinterest_tag).toBeNull();
    expect(r.domain_verify_tag).toBeNull();
    expect(r.save_button).toBeNull();
    expect(r.rich_pin.ready).toBeNull();
    expect(r.rich_pin.missing).toEqual([]);
    expect(r.impact).toEqual([]);
  });

  it("does not mistake pinterest.com/pin or /search for an account", () => {
    expect(pinterestProfileLinks(`"https://www.pinterest.com/search/pins/?q=x" "https://pinterest.com/ideas/"`)).toEqual([]);
  });
});

describe("pinterest_site_readiness", () => {
  beforeEach(() => {
    vi.mocked(resolveTenantSite).mockResolvedValue("https://www.shop.example");
    vi.mocked(safeFetchText).mockReset();
  });

  it("refuses any page that is not on the tenant's own domain", async () => {
    await expect(
      pinterestSiteReadinessTool.execute(ctx, { urls: ["https://evil.example/products/x"] }),
    ).rejects.toMatchObject({ code: "tool_input_invalid" });
    expect(safeFetchText).not.toHaveBeenCalled();
  });

  it("resolves paths against their site and reports an unfetched page as unverified", async () => {
    vi.mocked(safeFetchText).mockResolvedValueOnce(PRODUCT_PAGE).mockResolvedValueOnce(null);
    const out = (await pinterestSiteReadinessTool.execute(ctx, { urls: ["/products/runner", "/about"] })) as {
      pages: Array<{ url: string; fetched: boolean }>;
    };
    expect(vi.mocked(safeFetchText).mock.calls[0][0]).toBe("https://www.shop.example/products/runner");
    expect(vi.mocked(safeFetchText).mock.calls[0][1]).toBe("shop.example");
    expect(out.pages[0].fetched).toBe(true);
    expect(out.pages[1]).toMatchObject({ fetched: false });
  });

  it("refuses a sibling on a shared host (x.myshopify.com is not y.myshopify.com)", async () => {
    vi.mocked(resolveTenantSite).mockResolvedValue("https://acme.myshopify.com");
    await expect(
      pinterestSiteReadinessTool.execute(ctx, { urls: ["https://rival.myshopify.com/products/x"] }),
    ).rejects.toMatchObject({ code: "tool_input_invalid" });
    expect(safeFetchText).not.toHaveBeenCalled();
  });

  it("with no website on file says so instead of guessing", async () => {
    vi.mocked(resolveTenantSite).mockResolvedValue(null);
    await expect(pinterestSiteReadinessTool.execute(ctx, {})).rejects.toMatchObject({ code: "tool_no_data" });
  });
});
