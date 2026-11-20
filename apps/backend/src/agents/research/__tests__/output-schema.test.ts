import { describe, it, expect } from "vitest";
import { sourceSchema, validationChipSchema, blockSchema, sentimentSchema } from "../blocks";
import { researchReportSchema } from "../output-schema";

describe("research blocks", () => {
  it("accepts a valid source with http(s) url + accessed_at", () => {
    const ok = sourceSchema.safeParse({ n: 1, title: "Upcar", url: "https://upcar.ai", accessed_at: "2026-05-20" });
    expect(ok.success).toBe(true);
  });

  it("rejects a javascript: source url", () => {
    const bad = sourceSchema.safeParse({ n: 1, title: "x", url: "javascript:alert(1)", accessed_at: "2026-05-20" });
    expect(bad.success).toBe(false);
  });

  it("rejects sentiment that does not sum to 100", () => {
    expect(sentimentSchema.safeParse({ pos: 50, neu: 10, neg: 10 }).success).toBe(false);
    expect(sentimentSchema.safeParse({ pos: 80, neu: 20, neg: 0 }).success).toBe(true);
  });

  it("accepts a competitive_table block and rejects an unknown block type", () => {
    const good = blockSchema.safeParse({
      type: "competitive_table",
      rows: [{ brand: "Turo", positioning: "P2P leader", gap: "fees", citations: [1] }],
    });
    expect(good.success).toBe(true);
    const bad = blockSchema.safeParse({ type: "totally_made_up", foo: 1 });
    expect(bad.success).toBe(false);
  });

  it("P1-4: an uncited factual block (qa_grid) now PARSES — citations defaults to [] (was: required → whole-report stub)", () => {
    const parsed = blockSchema.safeParse({ type: "qa_grid", items: [{ question: "q", answer_md: "a" }] });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === "qa_grid") {
      expect(parsed.data.items[0].citations).toEqual([]);
    }
  });
});

describe("researchReportSchema", () => {
  const baseReport = {
    kind: "report",
    template: "landscape",
    title: "T",
    query: "the ask",
    blocks: [{ type: "hero", title: "T" }],
    lenses: [],
    sources: [{ n: 1, title: "s", url: "https://a.com", accessed_at: "2026-05-20" }],
    validation: [{ tier: "inferred", text: "x", supporting_source_indices: [1] }],
    failed_lenses: [],
    generated_at: "2026-05-20T00:00:00Z",
  };

  it("accepts a valid report envelope", () => {
    expect(researchReportSchema.safeParse(baseReport).success).toBe(true);
  });

  it("accepts a clarification envelope with 2-4 questions", () => {
    const ok = researchReportSchema.safeParse({
      kind: "clarification",
      questions: [{ question: "scope?", why: "ambiguous" }, { question: "region?", why: "matters" }],
    });
    expect(ok.success).toBe(true);
  });

  it("rejects clarification with 1 question", () => {
    const bad = researchReportSchema.safeParse({ kind: "clarification", questions: [{ question: "q", why: "w" }] });
    expect(bad.success).toBe(false);
  });

  it("rejects clarification with 5 questions (upper bound)", () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ question: `q${i}`, why: "w" }));
    expect(researchReportSchema.safeParse({ kind: "clarification", questions: five }).success).toBe(false);
  });

  it("rejects an unknown template", () => {
    expect(researchReportSchema.safeParse({ ...baseReport, template: "nope" }).success).toBe(false);
  });
});
