import { describe, it, expect } from "vitest";
import { isAppEditIntent, classifyAppEdit } from "../app-edit-intent";

describe("isAppEditIntent — Website-tab app-edit classifier", () => {
  it("matches genuine app-edit asks", () => {
    for (const s of [
      "i want to build change the theme of the site",
      "change the theme to green",
      "make the header blue",
      "update the hero copy",
      "add a pricing section",
      "Create a pricing table or cards section showcasing different bike rental rates by duration (hourly, daily, weekly) with clear pricing and features included.",
      "Build a features or benefits section highlighting what makes the company unique.",
      "Insert a testimonials section below the hero.",
      "Introduce a contact footer with business hours.",
      "remove the footer logo",
      "make the site dark mode",
      "redesign my landing page",
      "the header should be sticky",
      "fix the checkout bug on the site",
      "swap the font to Inter",
      "increase the padding on the hero section",
      "rewrite the headline",
    ]) {
      expect(isAppEditIntent(s), s).toBe(true);
    }
  });

  it("does NOT capture the Website tab's own suggestion chips", () => {
    for (const s of [
      "What did the team do this week?",
      "What needs my attention right now?",
      "Draft a short update for investors",
    ]) {
      expect(isAppEditIntent(s), s).toBe(false);
    }
  });

  it("does NOT capture the Grow surface's six suggestion chips", () => {
    for (const s of [
      "What's my 30 day marketing strategy?",
      "Who's my target customer and what pain points should I lead with?",
      "Show me the competitors I'm tracking",
      "How do you think we should position our product?",
      "Write me a one-liner that sells my product better",
      "How can we grow our organic traffic in the next 90 days?",
    ]) {
      expect(isAppEditIntent(s), s).toBe(false);
    }
  });

  it("does NOT match questions or non-app work", () => {
    for (const s of [
      "how does the theme system work?",
      "what colors are we using on the site?",
      "who changed the header last week?",
      "show me the pricing page traffic",
      "summarize the last deploy",
      "update the investors on our runway",
      "add ravi to the slack channel",
      "explain why the build failed",
      "",
      "   ",
    ]) {
      expect(isAppEditIntent(s), s).toBe(false);
    }
  });

  it("is null/undefined-safe", () => {
    expect(isAppEditIntent(null)).toBe(false);
    expect(isAppEditIntent(undefined)).toBe(false);
  });

  it("caps pathologically long input without throwing", () => {
    expect(isAppEditIntent(`${"a".repeat(10_000)} change the theme`)).toBe(false);
    expect(isAppEditIntent(`change the theme ${"a".repeat(10_000)}`)).toBe(true);
  });
});

describe("classifyAppEdit — simple vs structural", () => {
  it("routes add/remove/layout/theme/section to structural (rebuild)", () => {
    for (const s of [
      "add a pricing section",
      "add a testimonial section",
      "remove the footer logo",
      "change the theme to green",
      "make the site dark mode",
      "redesign my landing page",
      "change the page layout",
      "reorder the nav bar",
    ]) {
      expect(classifyAppEdit(s), s).toBe("structural");
    }
  });

  it("routes text/colour/font/link/image edits on an element to simple (instant)", () => {
    for (const s of [
      "change the tagline to 'Clothes worth keeping'",
      "make the button blue",
      "swap the font to Inter",
      "rewrite the headline",
      "update the hero copy",
      "change the logo image",
      "set the cta text to 'Buy now'",
    ]) {
      expect(classifyAppEdit(s), s).toBe("simple");
    }
  });

  it("returns none for questions / non-edits, and is null-safe", () => {
    for (const s of ["how does the theme system work?", "what colours are we using?", "", "   "]) {
      expect(classifyAppEdit(s), s).toBe("none");
    }
    expect(classifyAppEdit(null)).toBe("none");
    expect(classifyAppEdit(undefined)).toBe("none");
  });
});
