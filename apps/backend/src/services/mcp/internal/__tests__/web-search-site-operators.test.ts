import { describe, expect, it } from "vitest";
import { dropOffTopicSiteResults, splitSiteOperators } from "../web-search";

describe("splitSiteOperators", () => {
  it("moves site: into include_domains and keeps the words", () => {
    expect(splitSiteOperators("site:x.com plausiblehq")).toEqual({
      query: "plausiblehq",
      include_domains: ["x.com"],
    });
  });

  it("a query of only site: operators keeps the path as search words (was a Tavily 400)", () => {
    expect(splitSiteOperators("site:x.com/PlausibleHQ/status")).toEqual({
      query: "PlausibleHQ",
      include_domains: ["x.com"],
    });
  });

  it("a bare site:domain falls back to the domain as the query", () => {
    expect(splitSiteOperators("site:counsilplumbing.com")).toEqual({
      query: "counsilplumbing.com",
      include_domains: ["counsilplumbing.com"],
    });
  });

  it("handles several sites, a scheme, and an OR between them", () => {
    const r = splitSiteOperators('"google analytics alternative" site:https://reddit.com OR site:x.com');
    expect(r.include_domains).toEqual(["reddit.com", "x.com"]);
    expect(r.query).toBe('"google analytics alternative"');
  });

  it("drops an exclusion instead of including it", () => {
    expect(splitSiteOperators("plumber san jose -site:yelp.com")).toEqual({
      query: "plumber san jose",
      include_domains: [],
    });
  });

  it("leaves a query with no site: untouched", () => {
    expect(splitSiteOperators("privacy analytics 2026")).toEqual({
      query: "privacy analytics 2026",
      include_domains: [],
    });
  });
});

describe("dropOffTopicSiteResults", () => {
  const junk = [
    { title: "GDPR", url: "https://gdpr.x.com", content: "privacy policy" },
    { title: "CaixaResearch (@CaixaResearch) / X", url: "https://x.com/CaixaResearch", content: "economics" },
  ];
  const hit = { title: "Plausible Analytics (@PlausibleHQ) / X", url: "https://x.com/PlausibleHQ", content: "" };

  it("a handle the index does not hold comes back empty, not as random accounts", () => {
    expect(dropOffTopicSiteResults(junk, "UpcarCarRental", ["x.com"])).toEqual([]);
  });

  it("keeps a result that mentions a query word", () => {
    expect(dropOffTopicSiteResults([...junk, hit], "plausiblehq", ["x.com"])).toEqual([hit]);
  });

  it("does not filter an unrestricted search", () => {
    expect(dropOffTopicSiteResults(junk, "UpcarCarRental", [])).toEqual(junk);
  });
});
