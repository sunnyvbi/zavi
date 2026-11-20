import { describe, it, expect } from "vitest";
import { startLineFor } from "./startLine";

describe("startLineFor", () => {
  it("names the topic of the message once the run is picked up", () => {
    expect(startLineFor("How did the Atlanta Meta ads do yesterday?", false)).toBe("Looking at your Meta ads…");
    expect(startLineFor("Is Google Ads counting our conversions?", false)).toBe("Checking your Google Ads…");
    expect(startLineFor("Why did host signups drop this week?", false)).toBe("Looking into your signups…");
    expect(startLineFor("Is our product page slow on the website?", false)).toBe("Checking your site…");
  });

  it("never claims work while the run is still queued", () => {
    expect(startLineFor("How did the Meta ads do?", true)).toBe("Getting started on your Meta ads…");
    expect(startLineFor("What should I focus on this week?", true)).toBe("Getting started…");
  });

  it("matches whole words only", () => {
    expect(startLineFor("Look at the opposite approach to fbx", true)).toBe("Getting started…");
  });

  it("does not read ordinary words as a channel", () => {
    expect(startLineFor("Rank these three launch ideas", true)).toBe("Getting started…");
    expect(startLineFor("Fix the meta description on the pricing page", false)).not.toContain("Meta ads");
    expect(startLineFor("Should I spend time on partnerships?", true)).toBe("Getting started…");
    expect(startLineFor("Sort these in order of impact", true)).toBe("Getting started…");
  });

  it("varies the plain line by message and keeps it stable for one message", () => {
    const asks = ["What should I focus on?", "Any ideas for next week?", "Summarize where we are", "What would you do?", "Help me think"];
    const lines = new Set(asks.map((a) => startLineFor(a, false)));
    expect(lines.size).toBeGreaterThan(1);
    expect(startLineFor(asks[0], false)).toBe(startLineFor(asks[0], false));
  });

  it("falls back to Getting started with no message", () => {
    expect(startLineFor(undefined, false)).toBe("Getting started…");
    expect(startLineFor("   ", false)).toBe("Getting started…");
  });
});
