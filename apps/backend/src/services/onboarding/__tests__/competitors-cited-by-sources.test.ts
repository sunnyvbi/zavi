import { describe, expect, it } from "vitest";
import { competitorsCitedBySources } from "../brainstorm-research";

const sources = [
  { title: "Acme vs Globex: which planner wins in 2026", url: "https://review.example/acme-vs-globex" },
  { title: "Pricing", url: "https://www.initech.io/pricing" },
  { title: "Email automation platforms compared", url: "https://blog.example/why-hire-an-agency" },
  { title: "Tools", url: "https://tools.example.app/" },
];

describe("competitorsCitedBySources", () => {
  it("keeps names a source title names as words, or a hostname label names", () => {
    expect(competitorsCitedBySources(["Acme", "Globex", "Initech"], sources)).toEqual([
      "Acme",
      "Globex",
      "Initech",
    ]);
  });

  it("drops substitutes and names no source names", () => {
    expect(competitorsCitedBySources(["Spreadsheets", "An agency", "Umbrella Corp"], sources)).toEqual([]);
  });

  it("does not match inside words, in URL paths, or on a TLD", () => {
    expect(competitorsCitedBySources(["AI", "Agency", "App", "io", "www"], sources)).toEqual([]);
  });

  it("drops blanks", () => {
    expect(competitorsCitedBySources(["", "  "], sources)).toEqual([]);
  });

  it("keeps article-led brands and punctuated domains", () => {
    const src = [
      { title: "Top adtech platforms", url: "https://www.thetradedesk.com/" },
      { title: "Pricing", url: "https://acme-labs.com/pricing" },
      { title: "Hotels", url: "https://www.booking.com/" },
      { title: "AI video", url: "https://www.d-id.com/products" },
    ];
    expect(competitorsCitedBySources(["The Trade Desk", "Acme Labs", "Booking.com", "D-ID"], src)).toEqual([
      "The Trade Desk",
      "Acme Labs",
      "Booking.com",
      "D-ID",
    ]);
  });

  it("does not let a two-letter host label cite a category", () => {
    expect(competitorsCitedBySources(["AI"], [{ title: "Research", url: "https://ai.google/research" }])).toEqual([]);
  });

  it("an article-led phrase in a title is a substitute; a two-letter brand counts by its own domain", () => {
    const src = [
      { title: "The status quo in B2B attribution", url: "https://blog.example/post" },
      { title: "Laptops", url: "https://www.hp.com/us-en/shop" },
    ];
    expect(competitorsCitedBySources(["The status quo", "HP"], src)).toEqual(["HP"]);
  });
});
