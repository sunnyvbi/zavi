import { describe, it, expect } from "vitest";
import {
  answerPosition,
  brandAliasesOf,
  canonicalPageUrl,
  findName,
  isOwned,
  mentionSpans,
  resolveCitation,
  rivalsMentioned,
  stripUrls,
} from "../detect";

describe("findName — a mention is the brand named in prose", () => {
  it("matches whole words, case-insensitively, with offsets into the original text", () => {
    const text = "Try Zavi or zavi's growth agent.";
    expect(findName(text, "Zavi")).toEqual([
      { start: 4, end: 8 },
      { start: 12, end: 16 },
    ]);
  });

  it("does not match inside a longer word", () => {
    expect(findName("Zavier recommends cupcar", "Zavi")).toEqual([]);
    expect(findName("cupcar", "Upcar")).toEqual([]);
  });

  it("does NOT count a bare link as naming the brand — a citation is not a mention", () => {
    const text = "See https://upcar.ai/pricing for details.";
    expect(findName(text, "upcar")).toEqual([]);
    expect(findName("[a guide](https://upcar.ai/guide)", "upcar")).toEqual([]);
  });

  it("does count link TEXT, which a reader sees", () => {
    const text = "[Upcar](https://upcar.ai) rents cars.";
    expect(findName(text, "Upcar")).toEqual([{ start: 1, end: 6 }]);
  });

  it("ignores names too short to mean anything", () => {
    expect(findName("AI is here", "AI")).toEqual([]);
  });

  it("escapes regex characters in names", () => {
    expect(findName("Use A+B Tools today", "A+B Tools")).toHaveLength(1);
  });

  it("keeps offsets aligned after URL stripping", () => {
    const text = "https://x.com/a Zavi";
    expect(stripUrls(text)).toHaveLength(text.length);
    expect(findName(text, "Zavi")).toEqual([{ start: 16, end: 20 }]);
  });
});

describe("brand aliases", () => {
  it("is the name and each owned host, not the bare host label", () => {
    expect(brandAliasesOf("Zavi", ["zaviagent.com"])).toEqual(["Zavi", "zaviagent.com"]);
  });

  it("merges overlapping spans from two aliases", () => {
    const spans = mentionSpans("Visit upcar.ai today", brandAliasesOf("upcar.ai", ["upcar.ai"]));
    expect(spans).toHaveLength(1);
  });
});

describe("rivalsMentioned", () => {
  it("returns rivals named in the answer, never the brand itself", () => {
    const text = "Turo and Getaround are popular; Upcar is newer.";
    expect(rivalsMentioned(text, ["Turo", "Getaround", "Zoomcar", "Upcar"], "Upcar")).toEqual(["Turo", "Getaround"]);
  });
});

describe("resolveCitation", () => {
  it("resolves a normal link to its host without www", () => {
    expect(resolveCitation({ url: "https://www.reddit.com/r/x", title: "t", domain: null })).toEqual({
      url: "https://www.reddit.com/r/x",
      domain: "reddit.com",
      title: "t",
      infra: false,
    });
  });

  it("credits a Gemini grounding redirect to the domain its title names", () => {
    const r = resolveCitation({
      url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC",
      title: "linkedin.com",
      domain: null,
    });
    expect(r).toMatchObject({ domain: "linkedin.com", infra: false });
  });

  it("keeps an unresolvable redirect as infrastructure rather than guessing", () => {
    const r = resolveCitation({
      url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC",
      title: "Best tools for small teams",
      domain: null,
    });
    expect(r).toMatchObject({ domain: "vertexaisearch.cloud.google.com", infra: true });
  });
});

describe("isOwned + canonicalPageUrl", () => {
  it("owns the domain and its subdomains, not look-alikes", () => {
    expect(isOwned("zaviagent.com", ["zaviagent.com"])).toBe(true);
    expect(isOwned("docs.zaviagent.com", ["zaviagent.com"])).toBe(true);
    expect(isOwned("notzaviagent.com", ["zaviagent.com"])).toBe(false);
    expect(isOwned(null, ["zaviagent.com"])).toBe(false);
  });

  it("drops tracking params, fragments and a trailing slash so a page counts once", () => {
    expect(canonicalPageUrl("https://www.Example.com/pricing/?utm_source=chatgpt.com&plan=pro#faq")).toBe(
      "https://example.com/pricing?plan=pro",
    );
    expect(canonicalPageUrl("https://example.com/")).toBe("https://example.com/");
  });
});

describe("answerPosition", () => {
  const pos = (text: string, brand = "Upcar", ownedCited = false) =>
    answerPosition(text, mentionSpans(text, [brand]), ownedCited);

  it("primary when the lead paragraph names the brand", () => {
    expect(pos("Upcar is the best option for renting a car.\n\n- Turo\n- Getaround")).toBe("primary");
  });

  it("primary even under a heading", () => {
    expect(pos("## Best option\nUpcar rents cars by the hour.")).toBe("primary");
  });

  it("list_item when the brand only appears in a list", () => {
    expect(pos("Here are good options:\n\n1. Turo\n2. Upcar — hourly rentals")).toBe("list_item");
  });

  it("list_item when the answer OPENS with a list (there is no lead paragraph)", () => {
    expect(pos("- Upcar\n- Turo")).toBe("list_item");
  });

  it("list_item for a table row", () => {
    expect(pos("Options compared:\n\n| Name | Price |\n| Upcar | $10 |")).toBe("list_item");
  });

  it("in_body when named in later prose", () => {
    expect(pos("Car sharing is growing.\n\nSome people also try Upcar.")).toBe("in_body");
  });

  it("sources_only when unnamed but an owned page is cited, absent otherwise", () => {
    expect(pos("Car sharing is growing.", "Upcar", true)).toBe("sources_only");
    expect(pos("Car sharing is growing.")).toBe("absent");
  });
});
