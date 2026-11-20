import { describe, expect, it } from "vitest";
import { brandGuideSection } from "../design-guide";

describe("brandGuideSection", () => {
  it("names the customer's hexes and says they are not a suggestion", () => {
    const s = brandGuideSection({ primary: "#027bff", accent: "#afd0f6", source: "scrape" });
    expect(s).toContain("#027bff");
    expect(s).toContain("#afd0f6");
    expect(s.toLowerCase()).toContain("read from their own site");
    expect(s).toMatch(/do not\s+substitute/i);
  });

  it("says so when the customer set the colours by hand", () => {
    const s = brandGuideSection({ primary: "#d71505", source: "manual" });
    expect(s.toLowerCase()).toContain("set by the customer");
  });

  it("leaves out the page colours nobody asked for when they are absent", () => {
    const s = brandGuideSection({ primary: "#027bff", accent: null, bg: null, text: null, source: "scrape" });
    const values = s.split("\n").find((l) => l.includes("main #027bff"))!;
    expect(values.trim()).toBe("main #027bff");
  });

  it("carries bg and text through when the kit has them", () => {
    const s = brandGuideSection({
      primary: "#027bff",
      bg: "#ffffff",
      text: "#000000",
      source: "scrape",
    });
    expect(s).toContain("background #ffffff");
    expect(s).toContain("text #000000");
  });

  it("NEVER hands over the platform hexes on a kit we could not read", () => {
    const s = brandGuideSection({ primary: "#027bff", source: "default" });
    expect(s).not.toContain("#027bff");
    expect(s).toMatch(/do not invent/i);
    expect(s).toContain("#18181b");
  });

  it("treats an absent kit the same as an unreadable one", () => {
    expect(brandGuideSection(null)).toBe(brandGuideSection({ primary: "#027bff", source: "default" }));
    expect(brandGuideSection(undefined)).toMatch(/do not invent/i);
  });

  it("refuses a malformed hex rather than pasting it into a stylesheet", () => {
    const s = brandGuideSection({ primary: "red; } body { display:none", source: "scrape" });
    expect(s).toMatch(/do not invent/i);
    expect(s).not.toContain("display:none");
  });

  it("tells the page not to narrate what we could or could not read", () => {
    expect(brandGuideSection(null).toLowerCase()).toContain("say nothing on the page");
  });
});
