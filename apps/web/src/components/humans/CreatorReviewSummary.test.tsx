
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import {
  CreatorBadges,
  CreatorRating,
  CreatorReviewList,
  CreatorReviewSummary,
} from "./CreatorReviewSummary";
import {
  dimensionLines,
  ratingHeadline,
  type CreatorReviewAggregates,
  type CreatorReviewItem,
} from "./creatorReviewDisplay";

const NONE: CreatorReviewAggregates = {
  review_count: 0,
  avg_communication: null,
  avg_timeliness: null,
  avg_satisfaction: null,
  avg_overall: null,
};

const RATED: CreatorReviewAggregates = {
  review_count: 4,
  avg_communication: 4.8,
  avg_timeliness: 4.5,
  avg_satisfaction: 5,
  avg_overall: 4.77,
};

const REVIEWS: CreatorReviewItem[] = [
  {
    id: "r1",
    order_id: "o1",
    business_name: "Northwind Coffee",
    communication: 5,
    timeliness: 4,
    satisfaction: 5,
    body: "Turned three hooks around in a day.",
    created_at: "2026-08-05T00:00:00.000Z",
    updated_at: "2026-08-05T00:00:00.000Z",
  },
];

const CHECK_GLYPHS = ["✓", "✔", "☑", "✅", "&#10003;", "&check;"];

describe("a creator with no reviews", () => {
  it("says New to Zavi", () => {
    expect(renderToString(<CreatorRating aggregates={NONE} />)).toContain("New to Zavi");
  });

  it("shows no rating number at all — not 0, not 0.0", () => {
    const html = renderToString(<CreatorRating aggregates={NONE} />);
    expect(html).not.toContain("0.0");
    expect(html).not.toMatch(/>\s*0\s*</);
    expect(ratingHeadline(NONE)).toEqual({ kind: "new_to_zavi", label: "New to Zavi" });
    expect("score" in ratingHeadline(NONE)).toBe(false);
  });

  it("shows no per-dimension averages", () => {
    expect(dimensionLines(NONE)).toEqual([]);
    const html = renderToString(<CreatorReviewSummary aggregates={NONE} badges={[]} reviews={[]} />);
    expect(html).not.toContain("Communication");
  });
});

describe("a creator with real reviews", () => {
  it("shows the overall score and the review count", () => {
    const html = renderToString(<CreatorRating aggregates={RATED} />);
    expect(html).toContain("4.8");
    expect(html).toContain("4 review");
    expect(html).not.toContain("New to Zavi");
  });

  it("shows one line per dimension", () => {
    expect(dimensionLines(RATED)).toEqual([
      { label: "Communication", value: "4.8" },
      { label: "Timeliness", value: "4.5" },
      { label: "Satisfaction", value: "5.0" },
    ]);
  });

  it("says review, singular, for one review", () => {
    const one = { ...RATED, review_count: 1 };
    const html = renderToString(<CreatorRating aggregates={one} />);
    expect(html).toContain("1 review");
    expect(html).not.toContain("1 reviews");
  });
});

describe("badges", () => {
  it("renders nothing at all until one is earned", () => {
    expect(renderToString(<CreatorBadges badges={[]} />)).toBe("");
    const html = renderToString(<CreatorReviewSummary aggregates={NONE} badges={[]} reviews={[]} />);
    expect(html).not.toContain("Top Creator");
    expect(html).not.toContain("Responds Fast");
  });

  it("renders only the badges that were earned", () => {
    const html = renderToString(<CreatorBadges badges={["responds_fast"]} />);
    expect(html).toContain("Responds Fast");
    expect(html).not.toContain("Top Creator");
  });
});

describe("the review list", () => {
  it("shows the business that wrote the review as the author", () => {
    const html = renderToString(<CreatorReviewList reviews={REVIEWS} />);
    expect(html).toContain("Northwind Coffee");
    expect(html).toContain("Turned three hooks around in a day.");
  });

  it("renders nothing when there are no reviews", () => {
    expect(renderToString(<CreatorReviewList reviews={[]} />)).toBe("");
  });
});

describe("invariant 3: no tick or verified mark anywhere", () => {
  it("renders no check glyph on any state of the block", () => {
    const states = [
      renderToString(<CreatorReviewSummary aggregates={NONE} badges={[]} reviews={[]} />),
      renderToString(
        <CreatorReviewSummary
          aggregates={RATED}
          badges={["top_creator", "responds_fast"]}
          reviews={REVIEWS}
        />,
      ),
    ];
    for (const html of states) {
      for (const glyph of CHECK_GLYPHS) {
        expect(html).not.toContain(glyph);
      }
      expect(html).not.toContain("<svg");
      expect(html.toLowerCase()).not.toContain("verified");
    }
  });
});
