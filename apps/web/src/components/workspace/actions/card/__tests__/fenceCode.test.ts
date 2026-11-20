import { describe, expect, it } from "vitest";
import { fenceCode } from "../cardModel";

describe("fenceCode", () => {
  it("wraps runs of tag lines in one fenced block and keeps prose as paragraphs", () => {
    const out = fenceCode(["/ :", "<h1>Rent cars from local owners</h1>", "/long-term-rental :", "<h1>Rent a car by the month</h1>"].join("\n"));
    expect(out).toBe(["/ :", "", "```html", "<h1>Rent cars from local owners</h1>", "```", "", "/long-term-rental :", "", "```html", "<h1>Rent a car by the month</h1>", "```"].join("\n"));
  });

  it("leaves text that is already fenced alone", () => {
    const text = "Paste this:\n```\n<title>x</title>\n```";
    expect(fenceCode(text)).toBe(text);
  });

  it("does not fence a prose line that mentions a tag mid-sentence", () => {
    expect(fenceCode("Add an <h1> to the page.")).toBe("Add an <h1> to the page.");
  });
});
