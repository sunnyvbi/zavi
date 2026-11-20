import { describe, it, expect } from "vitest";
import {
  buildEnrichmentContext,
  CONTEXT_MAX_CHARS,
  RESEARCH_RESERVE_CHARS,
} from "../context";
import type { DomainPage } from "../types";

const page = (url: string, chars: number, fill: string): DomainPage => ({
  url,
  title: url,
  text_excerpt: fill.repeat(chars),
});

describe("buildEnrichmentContext", () => {
  it("still gives research a slice when the company's own pages overflow the window", () => {
    const own = [page("https://acme.com/", 6144, "a"), page("https://acme.com/shop", 6144, "b")];
    const research = [page("https://reviews.example/acme", 4000, "r")];
    const ctx = buildEnrichmentContext(own, research);
    expect(ctx.length).toBeLessThanOrEqual(CONTEXT_MAX_CHARS);
    expect(ctx).toContain("r".repeat(100));
    const researchChars = ctx.length - ctx.indexOf("r".repeat(100));
    expect(researchChars).toBeGreaterThanOrEqual(RESEARCH_RESERVE_CHARS - 200);
  });

  it("gives the whole window to the company's own pages when there is no research", () => {
    const own = [page("https://acme.com/", 6144, "a"), page("https://acme.com/shop", 6144, "b")];
    const ctx = buildEnrichmentContext(own, []);
    expect(ctx.length).toBe(CONTEXT_MAX_CHARS);
    expect(ctx).toContain("b");
  });

  it("puts the company's own pages first", () => {
    const ctx = buildEnrichmentContext(
      [page("https://acme.com/", 100, "a")],
      [page("https://reviews.example/acme", 100, "r")],
    );
    expect(ctx.indexOf("a")).toBeLessThan(ctx.indexOf("r"));
  });

  it("handles an empty crawl without throwing", () => {
    expect(buildEnrichmentContext([], [])).toBe("");
    expect(buildEnrichmentContext([], [page("https://x.example/y", 50, "r")])).toContain("r");
  });
});
