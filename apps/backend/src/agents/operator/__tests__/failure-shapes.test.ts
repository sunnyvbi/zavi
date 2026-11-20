import { describe, it, expect } from "vitest";
import {
  tagOperatorFailureShapes,
  OPERATOR_FAILURE_SHAPES,
  type FailureShapeInput,
} from "../failure-shapes";

const base: FailureShapeInput = {
  output_text: "Here is a normal grounded answer about your booking volume.",
  tool_calls: [{ name: "operator_db__query", status: "ok" }],
  question: "how many bookings last week?",
};

describe("operator failure-shape tagger — each shape detected", () => {
  it("capability-denial: denies WITHOUT having hunted (no read tool ran)", () => {
    const shapes = tagOperatorFailureShapes({
      output_text: "I can't access your pricing — that's not something I can do.",
      tool_calls: [],
      question: "what is our pricing?",
    });
    expect(shapes).toContain("capability-denial");
  });

  it("completeness-overclaim: asserts exhaustiveness with no grounding read", () => {
    const shapes = tagOperatorFailureShapes({
      output_text: "That's everything — the complete list, nothing else.",
      tool_calls: [],
      question: "list our plan tiers",
    });
    expect(shapes).toContain("completeness-overclaim");
  });

  it("metric-mislabel: numeric figure paired with two confusable metric nouns", () => {
    const shapes = tagOperatorFailureShapes({
      output_text: "Your GMV is $100,000/mo — that revenue is up nicely.",
      tool_calls: [{ name: "operator_db__query", status: "ok" }],
      question: "what's our GMV?",
    });
    expect(shapes).toContain("metric-mislabel");
  });

  it("dead-end-punt: handed off a pure read-only lookup to a specialist", () => {
    const shapes = tagOperatorFailureShapes({
      output_text: "Routing this to engineer to find the value.",
      tool_calls: [{ name: "praxis__handoff", status: "ok" }],
      question: "what is our cancellation fee?",
    });
    expect(shapes).toContain("dead-end-punt");
  });
});

describe("operator failure-shape tagger — precision gates (no FALSE tags)", () => {
  it("clean grounded answer tags NOTHING", () => {
    expect(tagOperatorFailureShapes(base)).toEqual([]);
  });

  it("capability-denial is SUPPRESSED when a read tool ran (honest post-read miss)", () => {
    const shapes = tagOperatorFailureShapes({
      output_text:
        "I checked memory and the repo — the cancellation fee isn't recorded, so I can't give an exact number.",
      tool_calls: [
        { name: "memory__search", status: "ok" },
        { name: "github__read_file", status: "ok" },
      ],
      question: "what is our cancellation fee?",
    });
    expect(shapes).not.toContain("capability-denial");
  });

  it("completeness-overclaim SUPPRESSED when a grounding read ran", () => {
    const shapes = tagOperatorFailureShapes({
      output_text: "That's the full list of your plan tiers.",
      tool_calls: [{ name: "memory__search", status: "ok" }],
      question: "list our plan tiers",
    });
    expect(shapes).not.toContain("completeness-overclaim");
  });

  it("capability-denial SUPPRESSED on a non-lookup ask (legit out-of-scope refusal)", () => {
    const shapes = tagOperatorFailureShapes({
      output_text: "I can't send that email on your behalf.",
      tool_calls: [],
      question: "send an email to my whole host list right now",
    });
    expect(shapes).not.toContain("capability-denial");
  });

  it("dead-end-punt SUPPRESSED when handoff is for an ACTION (not a lookup)", () => {
    const shapes = tagOperatorFailureShapes({
      output_text: "Handing this off to engineer to ship the fix.",
      tool_calls: [{ name: "praxis__handoff", status: "ok" }],
      question: "fix the broken checkout button and open a PR",
    });
    expect(shapes).not.toContain("dead-end-punt");
  });

  it("metric-mislabel NOT fired without a numeric value present", () => {
    const shapes = tagOperatorFailureShapes({
      output_text: "GMV and revenue are both tracked in the dashboard.",
      tool_calls: [{ name: "operator_db__query", status: "ok" }],
      question: "where do I see metrics?",
    });
    expect(shapes).not.toContain("metric-mislabel");
  });

  it("empty output_text tags nothing + never throws", () => {
    expect(tagOperatorFailureShapes({ output_text: "" })).toEqual([]);
    expect(tagOperatorFailureShapes({ output_text: null })).toEqual([]);
    expect(tagOperatorFailureShapes({ output_text: undefined })).toEqual([]);
  });
});

describe("operator failure-shape tagger — shallow-review", () => {
  const MONIQUE_SHALLOW =
    "Summary of what I flagged in the review: 1. Missing revision deadline. " +
    "2. No quotable comparison line. 3. Minor: 'Easy extensions' is a vague header. " +
    "The rest is accurate to the product and well-structured. Approve the email.";

  it("flags the real Monique shallow review", () => {
    const shapes = tagOperatorFailureShapes({
      output_text: MONIQUE_SHALLOW,
      question: "Can you review and share feedback?",
      tool_calls: [],
    });
    expect(shapes).toContain("shallow-review");
  });

  it.each([
    ["the rest is accurate and well-structured", "review this doc, any gaps?"],
    ["everything else looks solid.", "critique this launch post"],
    ["otherwise it's good.", "what do you think of this deck?"],
    ["the remainder reads clean.", "feedback on my email draft"],
  ])("flags remainder-dismissal %j on a review ask", (hedge, ask) => {
    const shapes = tagOperatorFailureShapes({
      output_text: `Two nits: the header and the CTA. ${hedge}`,
      question: ask,
      tool_calls: [],
    });
    expect(shapes).toContain("shallow-review");
  });

  it("does NOT flag a legitimate clean-doc review (affirms the WHOLE, not a remainder)", () => {
    const shapes = tagOperatorFailureShapes({
      output_text:
        "This is clean — grounded, on-message, right length, no must-fix. Two optional " +
        "lifts if you want them. I did NOT check whether the landing page matches.",
      question: "review this launch post — anything to fix?",
      tool_calls: [],
    });
    expect(shapes).not.toContain("shallow-review");
  });

  it("does NOT flag an honest 'what I did NOT check' disclosure", () => {
    const shapes = tagOperatorFailureShapes({
      output_text:
        "Three must-fixes: the brand contradiction, the insurance overload, the buried hook. " +
        "What I did NOT check: whether these prices are still live.",
      question: "can you review and share feedback?",
      tool_calls: [],
    });
    expect(shapes).not.toContain("shallow-review");
  });

  it("does NOT flag 'the rest is fine' on a NON-review turn (needs the review ask)", () => {
    const shapes = tagOperatorFailureShapes({
      output_text: "Top item: 47 stalled approvals. The rest is fine.",
      question: "what needs my attention today?",
      tool_calls: [{ name: "operator_db__query", status: "ok" }],
    });
    expect(shapes).not.toContain("shallow-review");
  });

  it("does NOT flag a review turn with no remainder-hedge", () => {
    const shapes = tagOperatorFailureShapes({
      output_text: "The doc is a B. Must-fix: the extensions section contradicts your core message.",
      question: "review this doc",
      tool_calls: [],
    });
    expect(shapes).not.toContain("shallow-review");
  });

  it("needs the captured question — a review reply alone (no ask) does not flag", () => {
    const shapes = tagOperatorFailureShapes({
      output_text: "Two nits. The rest is well-structured.",
      question: null,
      tool_calls: [],
    });
    expect(shapes).not.toContain("shallow-review");
  });
});

describe("operator failure-shape tagger — output contract", () => {
  it("returns shapes in taxonomy order, de-duplicated", () => {
    const shapes = tagOperatorFailureShapes({
      output_text: "I can't do that. That's everything anyway, nothing else.",
      tool_calls: [],
      question: "what is our pricing?",
    });
    const idx = shapes.map((s) => OPERATOR_FAILURE_SHAPES.indexOf(s));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    expect(new Set(shapes).size).toBe(shapes.length);
  });

  it("every emitted tag is in the controlled taxonomy", () => {
    const shapes = tagOperatorFailureShapes({
      output_text: "I cannot access that. The complete list is below. GMV $99 revenue.",
      tool_calls: [{ name: "praxis__handoff", status: "denied" }],
      question: "what is our pricing fee?",
    });
    for (const s of shapes) expect(OPERATOR_FAILURE_SHAPES).toContain(s);
  });
});
