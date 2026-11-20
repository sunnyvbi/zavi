
import { describe, it, expect } from "vitest";
import type { ResearchEnvelope } from "./ResearchEnvelopeRenderer";
import { rehydrateLeakedMarkdown } from "./ResearchEnvelopeRenderer";

const CLARIFICATION: ResearchEnvelope = {
  kind: "clarification",
  questions: [
    { question: "Which region?", why: "scope" },
    { question: "B2B or B2C?", why: "angle" },
  ],
};

const REPORT: ResearchEnvelope = {
  kind: "report",
  template: "landscape",
  title: "Market X",
  query: "q",
  blocks: [{ type: "hero", title: "Market X" }],
  lenses: [],
  sources: [
    { n: 1, title: "Src", url: "https://example.com", accessed_at: "2026-05-20" },
  ],
  validation: [],
  failed_lenses: [],
  generated_at: "2026-05-20T00:00:00Z",
};

describe("ResearchEnvelope type contract", () => {
  it("clarification envelope has kind and 2+ questions", () => {
    expect(CLARIFICATION.kind).toBe("clarification");
    expect(CLARIFICATION.questions.length).toBeGreaterThanOrEqual(2);
    for (const q of CLARIFICATION.questions) {
      expect(typeof q.question).toBe("string");
      expect(typeof q.why).toBe("string");
    }
  });

  it("report envelope has all required top-level fields", () => {
    expect(REPORT.kind).toBe("report");
    if (REPORT.kind === "report") {
      expect(typeof REPORT.title).toBe("string");
      expect(typeof REPORT.query).toBe("string");
      expect(Array.isArray(REPORT.blocks)).toBe(true);
      expect(Array.isArray(REPORT.sources)).toBe(true);
      expect(Array.isArray(REPORT.validation)).toBe(true);
      expect(Array.isArray(REPORT.failed_lenses)).toBe(true);
    }
  });

  it("discriminates on kind field", () => {
    const envelopes: ResearchEnvelope[] = [CLARIFICATION, REPORT];
    const kinds = envelopes.map((e) => e.kind);
    expect(kinds).toContain("clarification");
    expect(kinds).toContain("report");
  });
});

describe("source URL invariant", () => {
  const HTTP_SAFE = /^https?:\/\//i;

  it("example source uses http(s)", () => {
    if (REPORT.kind === "report") {
      for (const s of REPORT.sources) {
        expect(HTTP_SAFE.test(s.url)).toBe(true);
      }
    }
  });

  it("javascript: urls would NOT match the http(s) pattern", () => {
    expect(HTTP_SAFE.test("javascript:alert(1)")).toBe(false);
  });

  it("data: urls would NOT match the http(s) pattern", () => {
    expect(HTTP_SAFE.test("data:text/html,<h1>x</h1>")).toBe(false);
  });
});

describe("TIER_STYLE coverage", () => {
  it("chip tier strings are distinct and non-empty", () => {
    const TIER_STYLE: Record<
      "validated" | "inferred" | "assumption" | "high-risk",
      string
    > = {
      validated: "bg-green-100 text-green-800",
      inferred: "bg-blue-100 text-blue-800",
      assumption: "bg-amber-100 text-amber-800",
      "high-risk": "bg-red-100 text-red-800",
    };
    const tiers = Object.keys(TIER_STYLE) as (keyof typeof TIER_STYLE)[];
    expect(tiers).toHaveLength(4);
    const values = Object.values(TIER_STYLE);
    for (const v of values) expect(v.length).toBeGreaterThan(0);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe("block type handling", () => {
  it("a report with an unknown block type is structurally valid at the data layer", () => {
    const withUnknown: ResearchEnvelope = {
      kind: "report",
      template: "freeform",
      title: "T",
      query: "q",
      blocks: [
        { type: "hero", title: "T" },
        { type: "totally_new_block_type_v2", some_field: "value" },
      ],
      lenses: [],
      sources: [],
      validation: [],
      failed_lenses: [],
      generated_at: "2026-05-20T00:00:00Z",
    };
    expect(withUnknown.kind).toBe("report");
    if (withUnknown.kind === "report") {
      expect(withUnknown.blocks).toHaveLength(2);
      expect(withUnknown.blocks[1].type).toBe("totally_new_block_type_v2");
    }
  });

  it("a report containing every rich block type is structurally valid", () => {
    const richReport: ResearchEnvelope = {
      kind: "report",
      template: "customer-intel",
      title: "T",
      query: "q",
      blocks: [
        { type: "hero", title: "T" },
        { type: "exec_summary", prose_md: "s", citations: [1] },
        { type: "stat_tiles", tiles: [{ value: "10k", label: "users", citation: 1 }] },
        { type: "persona_cards", cards: [{ index: 1, name: "P", tagline: "t", fields: {}, buy_likelihood: 4, commentary_md: "c", citations: [1] }] },
        { type: "qa_grid", items: [{ question: "q", answer_md: "a", citations: [1] }] },
        { type: "theme_bars", bars: [{ label: "L", pct: 45, quote: "x", citations: [1] }] },
        { type: "sentiment_meter", sentiment: { pos: 80, neu: 20, neg: 0 } },
        { type: "cards_grid", cards: [{ title: "C", body_md: "b", meta: { label: "STRENGTH", value: "HIGH" }, citations: [1] }] },
        { type: "competitive_table", rows: [{ brand: "Turo", positioning: "p", gap: "g", citations: [1] }] },
        { type: "gap_list", items: [{ category: "cat", title: "G", body_md: "b", citations: [1] }] },
        { type: "recommendations", items: [{ index: 1, label: "01", title: "R", body_md: "b", citations: [1] }] },
        { type: "risks", items: [{ tone: "warn", title: "Risk", body_md: "b", citations: [1] }] },
        { type: "table", columns: ["A", "B"], rows: [["1", "2"]], citations: [1] },
        { type: "markdown", body_md: "md" },
        { type: "source_list", sources: [] },
      ],
      lenses: [],
      sources: [{ n: 1, title: "S", url: "https://x.com", accessed_at: "2026-05-20" }],
      validation: [{ tier: "validated", text: "ok", supporting_source_indices: [1] }],
      failed_lenses: [],
      generated_at: "2026-05-20T00:00:00Z",
    };
    if (richReport.kind === "report") {
      expect(richReport.blocks.length).toBe(15);
      expect(richReport.blocks.every((b) => typeof b.type === "string")).toBe(true);
    }
  });

  it("rehydrates leaked ```json blobs into typed blocks (prod shapes)", () => {
    const tiles = rehydrateLeakedMarkdown('```json\n{"stat_tiles":[{"label":"a","value":"b","sub":"c","citations":[1]}]}\n```');
    expect(tiles.prose).toBe("");
    expect(tiles.blocks).toEqual([
      { type: "stat_tiles", tiles: [{ label: "a", value: "b", sub: "c", citations: [1] }] },
    ]);

    const risks = rehydrateLeakedMarkdown('```json\n{"risks":[{"title":"t","body_md":"b","citations":[3]}]}\n```');
    expect(risks.blocks).toEqual([
      { type: "risks", items: [{ title: "t", body_md: "b", citations: [3] }] },
    ]);

    const heading = rehydrateLeakedMarkdown(
      '**White space the market changes opened**\n\n```json\n{"items":[{"title":"x","body_md":"y","citations":[4]}]}\n```',
    );
    expect(heading.prose).toBe("**White space the market changes opened**");
    expect(heading.blocks).toEqual([
      { type: "cards_grid", cards: [{ title: "x", body_md: "y", citations: [4] }] },
    ]);

    const sources = rehydrateLeakedMarkdown('```json\n{"sources":[1,2,3]}\n```');
    expect(sources.prose).toBe("");
    expect(sources.blocks).toEqual([]);

    const bad = rehydrateLeakedMarkdown("```json\n{not valid json\n```");
    expect(bad.prose).toBe("");
    expect(bad.blocks).toEqual([]);
  });

  it("drops leaked blocks whose array elements are null / non-objects", () => {
    const nullItems = rehydrateLeakedMarkdown('```json\n{"items":[null]}\n```');
    expect(nullItems.prose).toBe("");
    expect(nullItems.blocks).toEqual([]);

    const nullTiles = rehydrateLeakedMarkdown('```json\n{"stat_tiles":[null]}\n```');
    expect(nullTiles.prose).toBe("");
    expect(nullTiles.blocks).toEqual([]);

    const scalarRisks = rehydrateLeakedMarkdown('```json\n{"risks":["oops", 42, []]}\n```');
    expect(scalarRisks.blocks).toEqual([]);

    const mixed = rehydrateLeakedMarkdown(
      '```json\n{"items":[null, {"title":"x","body_md":"y","citations":[4]}]}\n```',
    );
    expect(mixed.blocks).toEqual([
      { type: "cards_grid", cards: [{ title: "x", body_md: "y", citations: [4] }] },
    ]);
  });

  it("leaves legit prose and non-JSON code fences untouched", () => {
    const plain = rehydrateLeakedMarkdown("Just normal **prose** with no JSON.");
    expect(plain.prose).toBe("Just normal **prose** with no JSON.");
    expect(plain.blocks).toEqual([]);
    const bash = "Run this:\n\n```bash\nnpm run build\n```";
    const r = rehydrateLeakedMarkdown(bash);
    expect(r.prose).toBe(bash);
    expect(r.blocks).toEqual([]);
  });

  it("failed_lenses is an array of strings", () => {
    const withFailed: ResearchEnvelope = {
      ...REPORT,
      kind: "report",
      failed_lenses: ["reviews", "ads"],
    };
    if (withFailed.kind === "report") {
      expect(withFailed.failed_lenses).toEqual(["reviews", "ads"]);
    }
  });
});
