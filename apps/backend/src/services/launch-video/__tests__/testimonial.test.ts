import { describe, it, expect } from "vitest";
import { intakeToVideoBrief, launchVideoIntakeSchema, type LaunchVideoIntake, type LaunchVideoTestimonial } from "../brief-mapper";
import { checkTestimonialProvenance, hasRealSource } from "../testimonial-grounding";
import { classifyVideoIntent, isTestimonialIntent, shouldRedirectTestimonialFromTalkingHead } from "../generative-video-intake";

const sourcedReview: LaunchVideoTestimonial = {
  quote: "Booked a car three blocks from my house in two minutes.",
  attribution: "Maria G.",
  rating: "5★",
  source: "operator_db reviews table (2026-06)",
};

const testimonialBase: LaunchVideoIntake = {
  product_name: "Upcar",
  one_liner: "Renters love it.",
  url: "https://upcar.ai",
  audience: "prospective renters",
  tone: "clean",
  video_type: "testimonial",
  features: [{ title: "Real local hosts", detail: "Thousands of cars from real people in your city." }],
  metrics: [
    { stat: "4.9★", label: "average rating" },
    { stat: "1,200+", label: "reviews" },
  ],
  testimonials: [sourcedReview],
  cta_text: "See why they love it",
  cta_url: "https://upcar.ai",
};

describe("testimonial — arc + real-quote cardwall (reuse, no new render code)", () => {
  it("is a valid video_type and renders hook -> cardwall(quotes) -> metric -> cta", () => {
    const brief = intakeToVideoBrief(testimonialBase);
    const kinds = brief.beats.map((b) => b.kind);
    expect(kinds[0]).toBe("hook");
    expect(kinds).toContain("cardwall");
    expect(kinds).toContain("metric");
    expect(kinds.at(-1)).toBe("cta");
  });

  it("cardwall is built from the REAL review quotes, not the feature list", () => {
    const brief = intakeToVideoBrief(testimonialBase);
    const wall = brief.beats.find((b) => b.kind === "cardwall") as { cards: { headline: string; body?: string; footer?: string }[] };
    expect(wall.cards[0].headline).toBe(sourcedReview.quote);
    expect(wall.cards[0].body).toBe("Maria G.");
    expect(wall.cards[0].footer).toBe("5★");
  });

  it("the provenance `source` never appears in any rendered brief string", () => {
    const brief = intakeToVideoBrief(testimonialBase);
    const blob = JSON.stringify(brief);
    expect(blob).not.toContain("operator_db reviews table");
  });
});

describe("testimonial provenance — the load-bearing clamp actually BLOCKS", () => {
  const fabricated: LaunchVideoTestimonial = {
    quote: "Best rental service in the entire world, five stars!",
    attribution: "Sarah M.",
    rating: "5★",
    source: "",
  };

  it("hasRealSource rejects empty / placeholder sources", () => {
    expect(hasRealSource("")).toBe(false);
    expect(hasRealSource("   ")).toBe(false);
    expect(hasRealSource("n/a")).toBe(false);
    expect(hasRealSource("made up")).toBe(false);
    expect(hasRealSource("example")).toBe(false);
    expect(hasRealSource("Google review 2026-06")).toBe(true);
  });

  it("(a) a fabricated/sourceless quote is REJECTED fail-closed (ok:false)", () => {
    const res = checkTestimonialProvenance([fabricated]);
    expect(res.ok).toBe(false);
    expect(res.violations.some((v) => v.field === "source")).toBe(true);
    expect(res.kept).toHaveLength(0);
  });

  it("a fully sourced quote passes", () => {
    const res = checkTestimonialProvenance([sourcedReview]);
    expect(res.ok).toBe(true);
    expect(res.kept).toEqual([sourcedReview]);
    expect(res.stripped).toHaveLength(0);
  });

  it("an anonymous quote (no attribution) is also rejected", () => {
    const res = checkTestimonialProvenance([{ quote: "Loved it.", attribution: "", source: "Yelp review" } as LaunchVideoTestimonial]);
    expect(res.ok).toBe(false);
    expect(res.violations.some((v) => v.field === "attribution")).toBe(true);
  });

  it("(b) warn-strip keeps sourced quotes and DROPS the unsourced one", () => {
    const res = checkTestimonialProvenance([sourcedReview, fabricated]);
    expect(res.ok).toBe(false);
    expect(res.kept).toEqual([sourcedReview]);
    expect(res.stripped).toEqual([fabricated]);
  });

  it("the mapper only renders quotes that survived the strip (no fabricated card)", () => {
    const kept = checkTestimonialProvenance([sourcedReview, fabricated]).kept;
    const brief = intakeToVideoBrief({ ...testimonialBase, testimonials: kept });
    const wall = brief.beats.find((b) => b.kind === "cardwall") as { cards: { headline: string }[] };
    expect(wall.cards.map((c) => c.headline)).toEqual([sourcedReview.quote]);
    expect(JSON.stringify(brief)).not.toContain("Best rental service in the entire world");
  });
});

describe("testimonial routing — NEVER the AI talking-head (customer impersonation)", () => {
  const prompts = [
    "make a testimonial video from our reviews",
    "a customer review video with our 5-star reviews",
    "social proof video of happy customers",
    "video of what our customers are saying",
  ];

  it("(c) testimonial-ish requests are recognized as testimonial intent", () => {
    for (const p of prompts) expect(isTestimonialIntent(p)).toBe(true);
  });

  it("(c) the bare classifier defaults a plain testimonial ask to talking_head (the risk)", () => {
    expect(classifyVideoIntent("make a testimonial video from our reviews")).toBe("talking_head");
  });

  it("(c) any talking_head + testimonial request is REDIRECTED away from talking_head", () => {
    for (const p of prompts) {
      expect(shouldRedirectTestimonialFromTalkingHead("talking_head", p)).toBe(true);
    }
  });

  it("a genuine talking-head request (not a testimonial) is NOT redirected", () => {
    expect(shouldRedirectTestimonialFromTalkingHead("talking_head", "a founder pitch to camera about our seed round")).toBe(false);
  });
});

describe("testimonial — schema accepts the review-quote card shape", () => {
  it("a {quote, attribution, rating, source} testimonial parses", () => {
    const parsed = launchVideoIntakeSchema.safeParse(testimonialBase);
    expect(parsed.success).toBe(true);
  });

  it("schema requires a source field on each testimonial", () => {
    const parsed = launchVideoIntakeSchema.safeParse({
      ...testimonialBase,
      testimonials: [{ quote: "Loved it.", attribution: "Maria G." }],
    });
    expect(parsed.success).toBe(false);
  });
});
