import { describe, it, expect } from "vitest";
import { stylesheetUrls, marketingUrlOf, DEFAULT_BRAND_KIT } from "../resolve-brand-kit";

describe("marketingUrlOf", () => {
  it("reads the marketing url out of the jsonb shape", () => {
    expect(marketingUrlOf({ marketing: "https://upcar.ai", api: "https://api.upcar.ai" })).toBe(
      "https://upcar.ai",
    );
  });
  it("accepts a bare string (legacy rows)", () => {
    expect(marketingUrlOf("https://upcar.ai")).toBe("https://upcar.ai");
  });
  it("never returns the api url as the brand surface", () => {
    expect(marketingUrlOf({ api: "https://api.upcar.ai" })).toBeNull();
  });
  it("is null-safe", () => {
    expect(marketingUrlOf(null)).toBeNull();
    expect(marketingUrlOf({})).toBeNull();
    expect(marketingUrlOf({ marketing: "   " })).toBeNull();
  });
});

describe("stylesheetUrls", () => {
  const page = "https://example.com/";

  it("resolves relative hrefs against the page", () => {
    const out = stylesheetUrls('<link rel="stylesheet" href="/assets/app.css">', page);
    expect(out).toEqual(["https://example.com/assets/app.css"]);
  });

  it("skips cross-origin sheets (a CDN framework sheet is not the tenant's brand)", () => {
    const out = stylesheetUrls(
      '<link rel="stylesheet" href="https://cdn.other.com/bootstrap.css">',
      page,
    );
    expect(out).toEqual([]);
  });

  it("ignores non-stylesheet links", () => {
    const out = stylesheetUrls('<link rel="icon" href="/favicon.ico">', page);
    expect(out).toEqual([]);
  });

  it("caps how many sheets it will pull", () => {
    const html = Array.from({ length: 9 }, (_, i) => `<link rel="stylesheet" href="/s${i}.css">`).join("");
    expect(stylesheetUrls(html, page).length).toBeLessThanOrEqual(3);
  });

  it("tolerates a malformed page url instead of throwing", () => {
    expect(stylesheetUrls('<link rel="stylesheet" href="/a.css">', "not a url")).toEqual([]);
  });
});

describe("DEFAULT_BRAND_KIT", () => {
  it("is explicitly labelled a default so a caller can never present it as the tenant's brand", () => {
    expect(DEFAULT_BRAND_KIT.source).toBe("default");
    expect(DEFAULT_BRAND_KIT.source_url).toBeNull();
    expect(DEFAULT_BRAND_KIT.evidence).toEqual([]);
  });
});
