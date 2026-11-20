import { describe, expect, it } from "vitest";
import type { SiteGatePageBlock, SiteGatePageText } from "../contract";
import { checkSiteCopy, SUBSTANTIAL_BLOCK } from "../site-copy-check";
import { qualifyingFindings } from "../site-vision-review";

function block(text: string): SiteGatePageBlock {
  const t = text.replace(/\s+/g, " ").trim();
  return { len: t.length, head: t.slice(0, 160) };
}

function long(seed: string, n = SUBSTANTIAL_BLOCK + 40): string {
  let out = seed;
  while (out.length < n) out += ` ${seed}`;
  return out.slice(0, n);
}

function page(path: string, blocks: string[], extraText: string[] = [], sections: string[] = []): SiteGatePageText {
  return { path, text: [...extraText, ...blocks].join("\n"), sections, blocks: blocks.map(block) };
}

const SERVICE = {
  hero: long("Lawn care and garden upkeep for homes across the valley, booked online in two minutes."),
  services: long("Mowing, edging, hedge trimming, leaf removal and seasonal clean-ups, priced per visit."),
  reviews: long("Neighbours say the crew is on time, tidy and friendly, and the yard has never looked better."),
  cta: "Ready for a tidy yard? Book your first visit today.",
};
const SHOP = {
  hero: long("Hand-poured candles and home fragrance, made in small batches and shipped in recyclable boxes."),
  catalog: long("Shop the bestsellers: cedar and smoke, fig leaf, sea salt, and the seasonal collection."),
  story: long("We started pouring candles in a garage and still test every scent at home before it ships."),
};
const PORTFOLIO = {
  hero: long("Independent photographer for weddings, portraits and brands, based in the city and travelling anywhere."),
  work: long("Selected work: recent weddings, studio portraits and product campaigns for local makers."),
  about: long("A decade behind the camera, a calm presence on the day, and photos delivered in two weeks."),
};

describe("checkSiteCopy", () => {
  it("finds nothing on clean sites of three shapes", () => {
    const sites: SiteGatePageText[][] = [
      [page("/", [SERVICE.hero, SERVICE.services, SERVICE.reviews, SERVICE.cta]), page("/book", [long("Pick a day and time that suits you, then confirm your address.")])],
      [page("/", [SHOP.hero, SHOP.catalog, SHOP.story]), page("/shop", [SHOP.catalog, long("Filter by scent family, size and price."), long("Free shipping over a set amount.")])],
      [page("/", [PORTFOLIO.hero, PORTFOLIO.work, PORTFOLIO.about]), page("/about", [PORTFOLIO.about, long("Kit list, process and what to expect."), long("Frequently asked questions about bookings.")])],
    ];
    for (const pages of sites) expect(checkSiteCopy(pages)).toEqual({ status: "checked", pages: pages.length, findings: [] });
  });

  it("flags a long section shown twice on one page as a high defect that qualifies for the fix pass", () => {
    const out = checkSiteCopy([page("/", [SERVICE.hero, SERVICE.reviews, SERVICE.services, SERVICE.reviews])]);
    expect(out.findings).toHaveLength(1);
    const f = out.findings[0]!;
    expect(f).toMatchObject({ page: "/", category: "repetition", severity: "high", class: "defect", source: "page", screenshot: "page /" });
    expect(f.evidence).toContain("appears 2 times on /");
    expect(qualifyingFindings(out.findings)).toHaveLength(1);
  });

  it("keeps a repeated short band (a call to action at the top and bottom) medium, recorded but never fixed", () => {
    const band = "Ready for a tidy yard? Book your first visit today and get a free quote for the season.";
    const out = checkSiteCopy([page("/", [band, SERVICE.hero, SERVICE.services, band])]);
    expect(out.findings.map((f) => f.severity)).toEqual(["medium"]);
    expect(qualifyingFindings(out.findings)).toEqual([]);
  });

  it("ignores blocks too short to matter (card buttons, prices)", () => {
    const out = checkSiteCopy([page("/", [SHOP.hero, "Add to cart", "Add to cart", "Add to cart", SHOP.catalog])]);
    expect(out.findings).toEqual([]);
  });

  it("flags a sub-page that is the home page again, and not one that shares a section or two", () => {
    const copied = checkSiteCopy([
      page("/", [PORTFOLIO.hero, PORTFOLIO.work, PORTFOLIO.about]),
      page("/services", [PORTFOLIO.hero, PORTFOLIO.work, PORTFOLIO.about]),
    ]);
    expect(copied.findings).toHaveLength(1);
    expect(copied.findings[0]).toMatchObject({ page: "/services", severity: "high", category: "repetition" });
    expect(copied.findings[0]!.evidence).toContain("3 of its 3 sections");

    const shared = checkSiteCopy([
      page("/", [SHOP.hero, SHOP.catalog, SHOP.story]),
      page("/about", [long("Who we are and how we work."), SHOP.story, long("Visit the workshop on weekends.")]),
    ]);
    expect(shared.findings).toEqual([]);
  });

  it("reports a planned section rendered twice with different text as medium", () => {
    const blocks = [
      { ...block(SERVICE.hero), mark: "hero" },
      { ...block(SERVICE.services), mark: "services" },
      { ...block(SERVICE.reviews), mark: "services" },
    ];
    const out = checkSiteCopy([{ path: "/", text: "", sections: ["hero", "services", "services"], blocks }]);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({ severity: "medium", evidence: expect.stringContaining('"services" is rendered 2 times') });
  });

  it("reports a long sentence repeated in the page text as low, once per sentence, at most two per page", () => {
    const s1 = "Every visit includes clippings removal and a quick walk-through with you at the end.";
    const s2 = "We are fully insured and every member of the crew has been with us for years.";
    const s3 = "Prices include travel within the valley and there is never a call-out charge.";
    const out = checkSiteCopy([page("/", [SERVICE.hero], [s1, s1, s2, s2, s3, s3])]);
    expect(out.findings.map((f) => f.severity)).toEqual(["low", "low"]);
    expect(qualifyingFindings(out.findings)).toEqual([]);
  });

  it("does not report a sentence that is part of a repeated section twice", () => {
    const out = checkSiteCopy([{ path: "/", text: `${SERVICE.reviews}\n${SERVICE.reviews}`, blocks: [block(SERVICE.reviews), block(SERVICE.reviews)] }]);
    expect(out.findings.map((f) => f.severity)).toEqual(["high"]);
  });

  it("counts only visible sections: a marker the page lists twice but shows once is no repeat", () => {
    const out = checkSiteCopy([{ path: "/", text: "", sections: ["hero", "services", "services"], blocks: [{ ...block(SERVICE.services), mark: "services" }] }]);
    expect(out.findings).toEqual([]);
  });

  it("skips owner and account pages, which may rightly repeat", () => {
    const out = checkSiteCopy([page("/admin", [SHOP.catalog, SHOP.catalog])]);
    expect(out).toEqual({ status: "checked", pages: 0, findings: [] });
  });

  it("puts high findings first", () => {
    const s = "Every visit includes clippings removal and a quick walk-through with you at the end.";
    const out = checkSiteCopy([page("/", [SERVICE.hero, SERVICE.reviews, SERVICE.reviews], [s, s])]);
    expect(out.findings.map((f) => f.severity)).toEqual(["high", "low"]);
  });
});
