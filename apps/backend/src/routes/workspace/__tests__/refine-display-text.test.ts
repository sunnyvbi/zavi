import { describe, expect, it } from "vitest";
import { refineAwaitsReview, refineDisplayText, userRequestFor } from "@/services/agents/refine-display";

describe("what the build conversation shows for a change", () => {
  it("shows the words the user typed when the run recorded them", () => {
    const graph = [{ payload: { user_request: "It looks like a template right now." } }];
    expect(refineDisplayText(graph, "Polish the Northline page so it no longer reads as a template. Based on…")).toBe(
      "It looks like a template right now.",
    );
  });

  it("pulls the quoted user words out of an agent-written brief for older runs", () => {
    const brief =
      'Polish the Northline coming-soon landing page so it no longer reads as a template. The user\'s exact words: "It looks like a template right now."\n\nBased on the build history, the current state has:\n- An SVG car';
    expect(refineDisplayText([], brief)).toBe("It looks like a template right now.");
  });

  it("falls back to the brief's first sentence, never the whole system-style prompt", () => {
    const brief =
      "The operator says the Northline car rental coming-soon page looks like a template and wants a more polished version.\n\nCurrent state: https://mohit-93bd8436.onrender.com — a Next.js coming-soon page with a hero";
    expect(refineDisplayText(null, brief)).toBe(
      "The operator says the Northline car rental coming-soon page looks like a template and wants a more polished version.",
    );
  });

  it("keeps a short plain request as it is", () => {
    expect(refineDisplayText(undefined, "Make the hero darker")).toBe("Make the hero darker");
  });
});

describe("userRequestFor", () => {
  it("prefers the user's own words and falls back to the message", () => {
    expect(userRequestFor("  add   a pricing section ", "long agent brief")).toBe("add a pricing section");
    expect(userRequestFor(null, "Make the hero darker")).toBe("Make the hero darker");
    expect(userRequestFor("", "")).toBeNull();
    expect(userRequestFor("x".repeat(2000), "m")?.length).toBe(1000);
  });
});

describe("refineAwaitsReview", () => {
  it("a merged code PR clears the review hold", () => {
    expect(refineAwaitsReview([{ payload: { stage: "build", awaiting_review: true } }], true)).toBe(false);
    expect(refineAwaitsReview([{ payload: { stage: "build", awaiting_review: true } }])).toBe(true);
  });

  it("flags a change parked for review, not one that deployed", () => {
    expect(
      refineAwaitsReview([
        { payload: { stage: "build", defer_pr: true } },
        { payload: { stage: "refine_gate" } },
      ]),
    ).toBe(true);
    expect(refineAwaitsReview([{ payload: { stage: "build" } }, { payload: { stage: "deploy" } }])).toBe(false);
    expect(refineAwaitsReview([{ payload: { stage: "build", refine_mode: true, awaiting_review: true } }])).toBe(true);
    expect(refineAwaitsReview(null)).toBe(false);
  });
});
