import { describe, expect, it } from "vitest";
import { clipKeepingLines } from "../question-text";

describe("clipKeepingLines (the 'You asked' answer keeps its paragraphs)", () => {
  it("keeps line breaks and collapses only spaces", () => {
    expect(clipKeepingLines("CPA should be $18.  \n\n\n\nBecause   your margin is thin.", 600)).toBe("CPA should be $18.\n\nBecause your margin is thin.");
  });
  it("clips at a word or line boundary with an ellipsis", () => {
    const out = clipKeepingLines("First line here.\nSecond line that is quite long indeed", 30);
    expect(out.length).toBeLessThanOrEqual(30);
    expect(out.endsWith("…")).toBe(true);
    expect(out.startsWith("First line here.")).toBe(true);
  });
});
