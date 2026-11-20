import { describe, expect, it } from "vitest";
import { askedText, combineIdeaAndPlan, fitClarifiedIdea } from "./buildPreSteps";

describe("buildPreSteps", () => {
  it("keeps the ask whole and trims only the plan to the cap", () => {
    expect(combineIdeaAndPlan("Make a site", "1. Home", 4000)).toBe("Make a site\n\nApproved plan:\n1. Home");
    expect(combineIdeaAndPlan("Make a site", "x".repeat(100), 40)).toBe(`Make a site\n\nApproved plan:\n${"x".repeat(12)}`);
    expect(combineIdeaAndPlan("Make a site", "   ", 4000)).toBe("Make a site");
  });

  it("shortens the idea, not the answers, when the clarified idea is too long", () => {
    const idea = "y".repeat(50);
    const answers = "\n\nAdditional context:\n- Name: The business is called \"Ok\".";
    const fitted = fitClarifiedIdea(idea, idea + answers, 70);
    expect(fitted.endsWith(answers)).toBe(true);
    expect(fitted.length).toBeLessThanOrEqual(70);
  });

  it("shows the founder's ask without the answers or the approved plan", () => {
    expect(askedText("A shop\n\nAdditional context:\n- Name: X")).toBe("A shop");
    expect(askedText("Add prices\n\nApproved plan:\n1. Prices")).toBe("Add prices");
    expect(askedText("Plain ask")).toBe("Plain ask");
    expect(askedText("Help me to make an Apple landing shop.\nAdditional context:\n- Name: The business is called \"Apple Hub\".\n- Product Focus: Accessories &amp; peripherals only")).toBe(
      "Help me to make an Apple landing shop.",
    );
    expect(askedText("Add prices\nApproved plan:\n1. Prices")).toBe("Add prices");
    expect(askedText("A shop\r\n\r\nAdditional context:\r\n- Name: X")).toBe("A shop");
    expect(askedText("Use the words Additional context: in the footer")).toBe("Use the words Additional context: in the footer");
    expect(
      askedText('Help me to make an Apple landing shop. Additional context: - Name: The business is called "Apple Hub". - Product Focus: Accessories & peripherals only'),
    ).toBe("Help me to make an Apple landing shop.");
    expect(askedText("Add prices Approved plan: 1. Prices table")).toBe("Add prices");
    expect(askedText("Additional context:\n- Name: X")).toBe("Additional context:\n- Name: X");
    expect(askedText(null)).toBeNull();
    expect(askedText("Create a page titled Additional context: Our story")).toBe("Create a page titled Additional context: Our story");
  });

  it("strips the answers in the sanitized form the server sends back (single newline)", () => {
    const stored = 'Can you help me make a mobile rental website?\nAdditional context:\n- Name: The business is called "MobileRent".\n- Logo: Add a logo';
    expect(askedText(stored)).toBe("Can you help me make a mobile rental website?");
    expect(askedText("Add prices\nApproved plan:\n1. Prices")).toBe("Add prices");
    expect(askedText('Help me make a cookie shop landing page. Additional context: - Name: The business is called &quot;Cookie shop&quot;. - Logo: Add a logo')).toBe(
      "Help me make a cookie shop landing page.",
    );
  });
});
