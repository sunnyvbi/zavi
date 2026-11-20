import { describe, it, expect } from "vitest";
import { resolveCtoChatIntent, SHIP_VERBS, INFO_VERBS, DESIGN_SHIP_VERBS } from "../intent";

describe("BUG 7 — design vocabulary reaches the design tool", () => {
  it("classifies the exact prompt that failed as NOT read-only", () => {
    const prompt =
      "Design me a simple landing page for a dog-walking app. Show me what it looks like.";
    expect(resolveCtoChatIntent(prompt)).not.toBe("info");
  });

  it("treats a bare design request as a ship turn", () => {
    for (const prompt of [
      "Design a pricing page for us",
      "Mock up a dashboard for the ops team",
      "Wireframe the onboarding flow",
      "Prototype a settings screen",
      "Sketch a landing page hero",
      "mockup a checkout page",
    ]) {
      expect(resolveCtoChatIntent(prompt), prompt).toBe("ship");
    }
  });

  it("does NOT hijack a genuine question ABOUT design", () => {
    for (const prompt of [
      "explain the design of the auth module",
      "what is the design pattern used here",
      "show me the database design",
      "how does the current design handle retries",
      "why did we design it that way",
    ]) {
      expect(resolveCtoChatIntent(prompt), prompt).toBe("info");
    }
  });

  it("keeps bare 'mock' out of the ship list", () => {
    expect(SHIP_VERBS).not.toContain("mock");
    expect(resolveCtoChatIntent("how do I mock the stripe client in tests")).toBe("info");
  });

  it("REGRESSION NET: design vocabulary exists at all", () => {
    const all = [...SHIP_VERBS, ...INFO_VERBS, ...DESIGN_SHIP_VERBS].join(" ");
    expect(all).toMatch(/design/);
    expect(all).toMatch(/wireframe/);
    expect(SHIP_VERBS).not.toContain("design");
  });

  it("does NOT grant write tools to a LABEL-led question", () => {
    for (const prompt of [
      "Design question: what is the current auth flow?",
      "Design review: how does checkout handle failed payments?",
      "Wireframe audit: show me where the homepage layout is defined",
      "Prototype status: update me on the build failure",
      "Mockup review: what build command renders the preview?",
      "Sketch notes: where is the theme set?",
      "design debt: what should we pay down first",
    ]) {
      expect(resolveCtoChatIntent(prompt), prompt).toBe("info");
    }
  });
});

describe("BUG 7 — every case adversarial review found, both directions", () => {
  it("LABEL PREFIX: anything left of a leading colon is a subject line", () => {
    for (const prompt of [
      "Design-review: how does checkout handle failed payments?",
      "Prototype report: what changed?",
      "Mockup screenshots: where are they saved?",
      "Design question: what is the current auth flow?",
      "Wireframe audit: show me where the homepage layout is defined",
    ]) {
      expect(resolveCtoChatIntent(prompt), prompt).toBe("info");
    }
  });

  it("POSSESSIVE and SENTENCE-END uses are nouns, not instructions", () => {
    expect(resolveCtoChatIntent("Can you summarize Ravi's design?")).not.toBe("ship");
    expect(resolveCtoChatIntent("Should the next step be design?")).not.toBe("ship");
  });

  it("INFLECTED forms are still real requests", () => {
    for (const prompt of [
      "Start prototyping the settings screen",
      "Start redesigning the dashboard header",
      "mock-up a checkout page",
      "Designing a pricing page now, show me the result",
    ]) {
      expect(resolveCtoChatIntent(prompt), prompt).not.toBe("info");
    }
  });

  it("keeps the original reported prompt working", () => {
    expect(
      resolveCtoChatIntent(
        "Design me a simple landing page for a dog-walking app. Show me what it looks like.",
      ),
    ).not.toBe("info");
  });
});

describe("BUG 7 — the label rule distinguishes a subject line from an instruction", () => {
  it("an instruction that HAPPENS to contain a colon still ships", () => {
    expect(
      resolveCtoChatIntent("Design a checkout page: include a pricing table and testimonials"),
    ).toBe("ship");
    expect(resolveCtoChatIntent("Wireframe the new onboarding: three steps, no signup")).toBe(
      "ship",
    );
  });

  it("KNOWN LIMIT, accepted: long prose LED by a design word reads as an instruction", () => {
    expect(
      resolveCtoChatIntent(
        "Design review notes for checkout failure recovery webhook retry policy details: how does checkout handle failed payments?",
      ),
    ).toBe("ship");
  });

  it("PLURAL design words are nouns, never instructions", () => {
    for (const prompt of [
      "Product designs need review",
      "Wireframes need review",
      "Prototypes need QA",
      "Mockups need review before Friday",
    ]) {
      expect(resolveCtoChatIntent(prompt), prompt).not.toBe("ship");
    }
  });

  it("KNOWN LIMIT, accepted: a design verb inside a quotation still reads as an instruction", () => {
    const quoted = 'Quote: "wireframe the onboarding flow". What files would change?';
    expect(resolveCtoChatIntent(quoted)).toBe("ship");
  });
});
