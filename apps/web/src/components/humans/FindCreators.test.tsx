
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { CreatorListSummary, CreatorRow, FindCreatorsIsland } from "./FindCreatorsIsland";
import type { CreatorSearchResult } from "@/lib/creator-storefront";

const render = (el: React.ReactElement<any>) => renderToString(el).replace(/<!-- -->/g, "");

const NOTE =
  "Zavi does not rank creators and does not pick one for you. Everyone who matches your filters is shown, in the order you chose.";

describe("the two lines above every result list", () => {
  it("states the honest thin-network count and the order applied", () => {
    const html = render(
      <CreatorListSummary count={6} orderLabel="Newest first" neutralityNote={NOTE} />,
    );
    expect(html).toContain("6 creators so far, you are seeing every one that matches.");
    expect(html).toContain("Order: Newest first.");
  });

  it("says Zavi does not rank and does not pick", () => {
    const html = render(
      <CreatorListSummary count={6} orderLabel="Newest first" neutralityNote={NOTE} />,
    );
    expect(html).toContain("does not rank");
    expect(html).toContain("does not pick one for you");
  });

  it("gets the singular right rather than printing '1 creators'", () => {
    const html = render(
      <CreatorListSummary count={1} orderLabel="A to Z" neutralityNote={NOTE} />,
    );
    expect(html).toContain("1 creator so far");
    expect(html).not.toContain("1 creators");
  });

  it("still states the order when nothing matched", () => {
    const html = render(
      <CreatorListSummary count={0} orderLabel="A to Z" neutralityNote={NOTE} />,
    );
    expect(html).toContain("No creator matches these filters yet.");
    expect(html).toContain("Order: A to Z.");
  });
});

describe("the screen itself", () => {
  it("renders, and starts busy rather than flashing an empty network", () => {
    const html = render(<FindCreatorsIsland />);
    expect(html).toContain("Find creators");
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("Nobody matches those filters yet");
  });

  it("offers only the two NEUTRAL orders — no best match, no cheapest first", () => {
    const html = render(<FindCreatorsIsland />);
    expect(html).toContain("Newest first");
    expect(html).toContain("A to Z");
    for (const banned of ["Best match", "Cheapest", "Top rated", "Recommended", "Most relevant"]) {
      expect(html, `the order picker offers '${banned}'`).not.toContain(banned);
    }
  });

  it("offers every filter the spec asks for (lane, platform, niche, price, days, location)", () => {
    const html = render(<FindCreatorsIsland />);
    expect(html).toContain("What you need");
    expect(html).toContain("Platform");
    expect(html).toContain("Niches");
    expect(html).toContain("Most you want to pay");
    expect(html).toContain("Days to deliver");
    expect(html).toContain("City");
    expect(html).toContain("Country");
    expect(html).not.toContain("audience_post");
    expect(html).not.toMatch(/Posts to their audience/i);
  });

  it("carries the package onward to the checkout, never back to the storefront", () => {
    const html = render(
      <FindCreatorsIsland preselectedCreator="ada" preselectedPackage="pkg-1" />,
    );
    expect(html).toContain("Ready to book ada");
    expect(html).toContain("Nothing has been charged yet");
    expect(html).toContain("/humans/book?package_id=pkg-1");
    expect(html).not.toContain("/ada?package=pkg-1");
  });
});

describe("one creator row (signed-in businesses only, storefront is off)", () => {
  const LABEL = "Self-reported, not checked by Zavi";
  const creator: CreatorSearchResult = {
    human_member_id: "m-1",
    slug: "ada",
    display_name: "Ada Makes",
    lanes: ["ugc_video"],
    niches: ["beauty"],
    platforms: ["tiktok"],
    location: { city: "Austin", country_code: "US" },
    bookable: true,
    not_bookable_message: null,
    self_reported_audience: [],
    handles: [
      { platform: "tiktok", handle: "ada", url: "https://www.tiktok.com/@ada", followers: 12000, label: LABEL },
    ],
    packages: [
      {
        id: "pkg-1",
        kind: "ugc_video",
        title: "Three hook videos",
        description: null,
        currency: "usd",
        delivery_days: 7,
        video_count: 3,
        video_length_seconds: 20,
        ad_rights_days: 90,
        addons: [],
        pricing: {
          price_cents: 15000,
          business_fee_cents: 1500,
          business_total_cents: 16500,
          creator_fee_cents: 2250,
          creator_payout_cents: 12750,
        },
      },
    ],
    from_price_cents: 15000,
    from_price_business_total_cents: 16500,
    joined_at: null,
  };

  it("shows the social handle, the self-reported followers and the label", () => {
    const html = render(<CreatorRow c={creator} briefId={null} selfReportedLabel={LABEL} />);
    expect(html).toContain('href="https://www.tiktok.com/@ada"');
    expect(html).toContain("noopener");
    expect(html).toContain("12,000 followers");
    expect(html).toContain(LABEL);
  });

  it("books a package through the checkout and never links a storefront", () => {
    const html = render(<CreatorRow c={creator} briefId="b-1" selfReportedLabel={LABEL} />);
    expect(html).toContain("/humans/book?package_id=pkg-1&amp;brief_id=b-1");
    expect(html).not.toContain("/creators/ada");
  });
});
