
import { describe, it, expect } from "vitest";
import { contentSeoDigestSchema } from "../output-schema";
import { recommendationToParsed, collectRecommendations } from "../post-run";

const goodRec = {
  change_type: "new_page",
  slug: "how-to-pick-a-crm",
  title: "How to pick a CRM",
  meta_description: "A practical guide.",
  target_keyword: "pick a crm",
  body: "## Start here\n\nPick the CRM that matches how you sell.",
  rationale: "fills a keyword gap",
  expected_impact: "ranks for a mid-funnel term",
};

describe("contentSeoDigestSchema — permissive recommendations array", () => {
  it("validates a digest where ONE rec is missing a field and ANOTHER is wrong-typed", () => {
    const res = contentSeoDigestSchema.safeParse({
      rendered_markdown: "this week's picks",
      recommendations: [
        goodRec,
        { change_type: "new_page", slug: "x" },
        { ...goodRec, slug: "y", title: 123 },
      ],
    });
    expect(res.success).toBe(true);
  });

  it("validates an empty / absent recommendations array", () => {
    expect(contentSeoDigestSchema.safeParse({ rendered_markdown: "x" }).success).toBe(true);
    expect(
      contentSeoDigestSchema.safeParse({ rendered_markdown: "x", recommendations: [] }).success,
    ).toBe(true);
  });
});

describe("recommendationToParsed — sole authoritative validator (adversarial)", () => {
  it("accepts a fully-valid new_page rec", () => {
    const r = recommendationToParsed(goodRec);
    expect("error" in r).toBe(false);
    expect((r as { slug: string }).slug).toBe("how-to-pick-a-crm");
  });

  it("drops a rec with the wrong change_type (does NOT emit a new_page publish)", () => {
    const r = recommendationToParsed({ ...goodRec, change_type: "edit_existing" });
    expect("error" in r).toBe(true);
  });

  it("drops a rec with a missing change_type", () => {
    const { change_type, ...noType } = goodRec;
    void change_type;
    expect("error" in recommendationToParsed(noType)).toBe(true);
  });

  it("drops (does NOT throw on) a wrong-typed field", () => {
    expect("error" in recommendationToParsed({ ...goodRec, title: 123 })).toBe(true);
    expect("error" in recommendationToParsed({ ...goodRec, body: null })).toBe(true);
    expect("error" in recommendationToParsed({ ...goodRec, slug: { nested: true } })).toBe(true);
  });

  it("drops a non-object entry without throwing", () => {
    expect("error" in recommendationToParsed("foo")).toBe(true);
    expect("error" in recommendationToParsed(42)).toBe(true);
    expect("error" in recommendationToParsed(null)).toBe(true);
  });

  it("ignores unknown extra fields and still emits when otherwise valid", () => {
    const r = recommendationToParsed({ ...goodRec, surprise: "ignored" });
    expect("error" in r).toBe(false);
  });

  it("rejects a path-traversal slug", () => {
    expect("error" in recommendationToParsed({ ...goodRec, slug: "../../etc/passwd" })).toBe(true);
  });
});

describe("collectRecommendations — drops bad, keeps good", () => {
  it("emits the valid recs and reports the dropped ones in parseError", () => {
    const { recs, parseError } = collectRecommendations({
      parsed: {
        rendered_markdown: "picks",
        recommendations: [
          goodRec,
          { change_type: "new_page", slug: "y" },
          { ...goodRec, slug: "third-post" },
        ],
      },
    });
    expect(recs.map((r) => r.slug)).toEqual(["how-to-pick-a-crm", "third-post"]);
    expect(parseError).toBeTruthy();
  });

  it("dedupes within-run on slug", () => {
    const { recs } = collectRecommendations({
      parsed: { rendered_markdown: "x", recommendations: [goodRec, { ...goodRec }] },
    });
    expect(recs.length).toBe(1);
  });
});
