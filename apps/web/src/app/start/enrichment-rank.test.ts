import { describe, it, expect } from "vitest";
import {
  brandFromTitle,
  commitCompanyName,
  decodeEntities,
  derivedCompanyName,
  inferCompanyName,
  isHomepageUrl,
  pageRank,
  resolveCompanyName,
  stripBrandSuffix,
} from "./enrichment-rank";

describe("decodeEntities — never show entities/markup to the user", () => {
  it("decodes site + XML-escape layers", () => {
    expect(decodeEntities("Refund policy &ndash; Sightglass Coffee")).toBe(
      "Refund policy – Sightglass Coffee",
    );
    expect(decodeEntities("Holo | AI Marketing Tool for Ads, Social Posts &amp; Emails")).toBe(
      "Holo | AI Marketing Tool for Ads, Social Posts & Emails",
    );
    expect(decodeEntities("Bundle 3+Bags &amp;amp; Save")).toBe("Bundle 3+Bags & Save");
    expect(decodeEntities("&lt;div class=&quot;x&quot;&gt;")).not.toMatch(/[<>]|&quot;/);
  });
});

describe("resolveCompanyName — the name saved as the tenant display name", () => {
  it("uses the scan's company_name over the domain guess", () => {
    expect(
      resolveCompanyName({ company_name: "Blue Bottle Coffee", domain_pages: [] }, "bluebottlecoffee.com"),
    ).toBe("Blue Bottle Coffee");
    expect(
      resolveCompanyName({ company_name: "Holo &amp; Co", domain_pages: [] }, "tryholo.ai"),
    ).toBe("Holo & Co");
  });

  it("falls back to the homepage title brand for older payloads", () => {
    expect(
      resolveCompanyName(
        { domain_pages: [{ url: "https://tryholo.ai/", title: "Holo | AI Marketing Tool" }] },
        "tryholo.ai",
      ),
    ).toBe("Holo");
  });

  it("recovers spacing from a title segment that spells the domain exactly (crawler blocked)", () => {
    expect(
      resolveCompanyName(
        {
          domain_pages: [],
          research_pages: [
            { url: "https://example.com/review", title: "Best coffee roasters 2026" },
            { url: "https://example.com/bb", title: "Blue Bottle Coffee - Wikipedia" },
          ],
        },
        "bluebottlecoffee.com",
      ),
    ).toBe("Blue Bottle Coffee");
  });

  it("uses the domain guess only when the scan found no name", () => {
    expect(resolveCompanyName({ domain_pages: [] }, "bluebottlecoffee.com")).toBe("Bluebottlecoffee");
    expect(resolveCompanyName(null, "blue-bottle.com")).toBe("Blue Bottle");
    expect(inferCompanyName("acme.io")).toBe("Acme");
  });
});

describe("brandFromTitle + isHomepageUrl", () => {
  it("extracts the brand from real homepage titles", () => {
    expect(brandFromTitle("Holo | AI Marketing Tool for Ads, Social Posts &amp; Emails", "tryholo.ai")).toBe(
      "Holo",
    );
    expect(brandFromTitle("Sightglass Coffee", "sightglasscoffee.com")).toBe("Sightglass Coffee");
    expect(brandFromTitle("Frequently Asked Questions | Refund policy", "sightglasscoffee.com")).toBe("");
  });

  it("only treats the root path as the homepage", () => {
    expect(isHomepageUrl("https://tryholo.ai")).toBe(true);
    expect(isHomepageUrl("https://sightglasscoffee.com/pages/faq")).toBe(false);
    expect(isHomepageUrl("not a url")).toBe(false);
  });
});

describe("pageRank — TLD-agnostic homepage detection", () => {
  it("ranks a non-.com apex homepage (upcar.ai/) as the homepage", () => {
    expect(pageRank("https://upcar.ai/", "Upcar — Rent Cars from Local Owners")).toBe(0);
    expect(pageRank("https://acme.com/", "Acme")).toBe(0);
  });

  it("ranks the homepage ABOVE nav/help pages for a .ai site", () => {
    const pages = [
      { url: "https://upcar.ai/help-center", title: "Help Center | Upcar" },
      { url: "https://upcar.ai/sell", title: "Sell Your Car | Upcar" },
      { url: "https://upcar.ai/", title: "Upcar — Rent Cars from Local Owners" },
    ];
    const top = [...pages].sort((a, b) => pageRank(a.url, a.title) - pageRank(b.url, b.title))[0];
    expect(top.url).toBe("https://upcar.ai/");
  });

  it("does NOT rank a malformed/relative URL as homepage", () => {
    expect(pageRank("not a url", "Help Center")).not.toBe(0);
    expect(pageRank("/about", "About")).not.toBe(0);
  });

  it("still ranks known sections", () => {
    expect(pageRank("https://upcar.ai/about", "About")).toBe(1);
    expect(pageRank("https://upcar.ai/pricing", "Pricing")).toBe(3);
    expect(pageRank("https://upcar.ai/terms", "Terms")).toBe(20);
  });
});

describe("stripBrandSuffix — chip cleanup", () => {
  it("drops a bare brand tail", () => {
    expect(stripBrandSuffix("Help Center | Upcar", "Upcar")).toBe("Help Center");
    expect(stripBrandSuffix("Pricing — Upcar", "Upcar")).toBe("Pricing");
  });

  it("keeps an informative tail even when it contains the brand", () => {
    expect(stripBrandSuffix("Pricing | Upcar for Hosts", "Upcar")).toBe("Pricing | Upcar for Hosts");
    expect(stripBrandSuffix("Upcar — Rent Cars from Local Owners", "Upcar")).toBe(
      "Upcar — Rent Cars from Local Owners",
    );
  });

  it("no-ops on empty brand or short titles", () => {
    expect(stripBrandSuffix("Home", "")).toBe("Home");
  });
});

describe("derivedCompanyName — one rule for the prefill AND the commit", () => {
  const host = "reenadaycare.com";
  const ok = { status: "ok", company_name: "Reena Day Care", domain_pages: [] };

  it("uses the scanned name when the scan succeeded", () => {
    expect(derivedCompanyName(ok, host)).toBe("Reena Day Care");
  });

  it("falls back to the host label when there is no usable scan", () => {
    for (const e of [null, undefined, { status: "skipped", reason: "request_failed" }]) {
      expect(derivedCompanyName(e, host)).toBe("Reenadaycare");
    }
  });

  it("keeps what the host label cannot recover — spacing, accents, punctuation", () => {
    expect(derivedCompanyName({ status: "ok", company_name: "Khiên Số", domain_pages: [] }, "khienso.com")).toBe(
      "Khiên Số",
    );
    expect(derivedCompanyName({ status: "ok", company_name: "Ko-fi", domain_pages: [] }, "ko-fi.com")).toBe("Ko-fi");
  });

});

describe("commitCompanyName — what a signup actually saves", () => {
  const host = "reenadaycare.com";
  const ok = { status: "ok", company_name: "Reena Day Care", domain_pages: [] };

  it("saves what the founder typed, even when the scan disagrees", () => {
    expect(commitCompanyName("Reena Day Care · Family child care", ok, host)).toBe(
      "Reena Day Care · Family child care",
    );
  });

  it("saves the derived name when the field was never touched", () => {
    expect(commitCompanyName(derivedCompanyName(ok, host), ok, host)).toBe("Reena Day Care");
  });

  it("falls back to the derived name when the field is empty or whitespace", () => {
    for (const v of ["", "   ", null, undefined]) {
      expect(commitCompanyName(v, ok, host)).toBe("Reena Day Care");
    }
  });

  it("still saves an edit when the scan failed", () => {
    expect(commitCompanyName("Reena Day Care", null, host)).toBe("Reena Day Care");
    expect(commitCompanyName("", null, host)).toBe("Reenadaycare");
  });

  it("trims what it saves, so a stray space cannot change the matched string", () => {
    expect(commitCompanyName("  Ko-fi  ", null, "ko-fi.com")).toBe("Ko-fi");
  });
});

describe("inferCompanyName on a platform host", () => {
  it("gives no name for a social profile or store listing", () => {
    for (const host of ["facebook.com", "m.facebook.com", "instagram.com", "linktr.ee", "amazon.co.uk", "apps.apple.com"]) {
      expect(inferCompanyName(host), host).toBe("");
      expect(derivedCompanyName(null, host), host).toBe("");
    }
  });

  it("still guesses from the founder's own domain", () => {
    expect(inferCompanyName("greenfarm.com")).toBe("Greenfarm");
    expect(inferCompanyName("notfacebook.com")).toBe("Notfacebook");
    expect(inferCompanyName("amazonia-coffee.com")).toBe("Amazonia Coffee");
  });
});
