import { describe, it, expect, vi } from "vitest";
import { groundResearchClaims, isFetchTrace } from "../claim-grounding";
import type { ResearchReport } from "../output-schema";
import type { Block, Source, ValidationChip } from "../blocks";

type ToolCall = { name: string; output_preview: string; input_preview?: string };

function fetchCall(url: string, text: string): ToolCall {
  return { name: "web_fetch__fetch", input_preview: JSON.stringify({ url }), output_preview: text };
}

function baseReport(over: Partial<ResearchReport> = {}): ResearchReport {
  return {
    kind: "report",
    template: "landscape",
    title: "T",
    query: "ask",
    blocks: [{ type: "exec_summary", prose_md: "summary", citations: [1] }],
    lenses: [],
    sources: [{ n: 1, title: "s1", url: "https://a.com/x", accessed_at: "2026-05-30" }],
    validation: [],
    failed_lenses: [],
    generated_at: "2026-05-30T00:00:00Z",
    ...over,
  };
}

const adjudicateAllFalse = vi.fn(async (pairs: { claim: string; sourceText: string }[]) =>
  pairs.map(() => false),
);

describe("groundResearchClaims", () => {
  it("a) downgrades a validated '58% female' chip whose only source lacks 58/gender", async () => {
    const sources: Source[] = [
      { n: 1, title: "demographics", url: "https://study.com/demo", accessed_at: "2026-05-30" },
      { n: 2, title: "other", url: "https://other.com/p", accessed_at: "2026-05-30" },
    ];
    const validation: ValidationChip[] = [
      { tier: "validated", text: "58% of drivers are female", supporting_source_indices: [1] },
    ];
    const report = baseReport({ sources, validation });
    const toolCalls = [
      fetchCall("https://study.com/demo", "The cohort skews young; median age 34 with rising adoption."),
    ];

    const { report: out, flags } = await groundResearchClaims(report, toolCalls, {
      adjudicate: adjudicateAllFalse,
    });

    const chip = out.validation[0];
    expect(chip.tier).toBe("inferred");
    expect(chip.supporting_source_indices).toEqual([]);
    expect(flags.downgraded).toBe(1);
    expect(flags.stripped).toBe(1);
    expect(out.validation.some((c) => c.tier === "high-risk" && /not found in cited source/.test(c.text))).toBe(true);
  });

  it("b) downgrades a contradicted fact (AmeriDrive bought HyreCar vs source says Getaround acquired HyreCar)", async () => {
    const sources: Source[] = [
      { n: 1, title: "ma", url: "https://news.com/ma", accessed_at: "2026-05-30" },
      { n: 2, title: "extra", url: "https://news.com/extra", accessed_at: "2026-05-30" },
    ];
    const validation: ValidationChip[] = [
      { tier: "validated", text: "AmeriDrive acquired HyreCar's 5000 vehicles", supporting_source_indices: [1, 2] },
    ];
    const report = baseReport({ sources, validation });
    const toolCalls = [
      fetchCall("https://news.com/ma", "Getaround acquired HyreCar in a distressed sale."),
      fetchCall("https://news.com/extra", "HyreCar wound down its peer-to-peer operations."),
    ];

    const { report: out, flags } = await groundResearchClaims(report, toolCalls, {
      adjudicate: adjudicateAllFalse,
    });

    const chip = out.validation[0];
    expect(chip.tier).toBe("inferred");
    expect(flags.downgraded).toBe(1);
    expect(out.validation.some((c) => c.tier === "high-risk")).toBe(true);
  });

  it("c) downgrades a wrong market-size figure whose cited source has a DIFFERENT number", async () => {
    const sources: Source[] = [
      { n: 1, title: "tam", url: "https://market.com/tam", accessed_at: "2026-05-30" },
      { n: 2, title: "tam2", url: "https://market.com/tam2", accessed_at: "2026-05-30" },
    ];
    const validation: ValidationChip[] = [
      { tier: "validated", text: "The TAM is $1B", supporting_source_indices: [1, 2] },
    ];
    const report = baseReport({ sources, validation });
    const toolCalls = [
      fetchCall("https://market.com/tam", "Analysts size the addressable market at $205M today."),
      fetchCall("https://market.com/tam2", "A separate estimate pegs it near $180M."),
    ];

    const { report: out, flags } = await groundResearchClaims(report, toolCalls, {
      adjudicate: adjudicateAllFalse,
    });

    expect(out.validation[0].tier).toBe("inferred");
    expect(flags.downgraded).toBe(1);
    expect(out.validation.some((c) => c.tier === "high-risk")).toBe(true);
  });

  it("d) downgrades a single-source validated chip to inferred", async () => {
    const sources: Source[] = [
      { n: 1, title: "s", url: "https://x.com/p", accessed_at: "2026-05-30" },
    ];
    const validation: ValidationChip[] = [
      { tier: "validated", text: "Revenue grew 40%", supporting_source_indices: [1] },
    ];
    const report = baseReport({ sources, validation });
    const toolCalls = [fetchCall("https://x.com/p", "Revenue grew 40% year over year.")];

    const { report: out, flags } = await groundResearchClaims(report, toolCalls, {
      adjudicate: adjudicateAllFalse,
    });

    expect(out.validation[0].tier).toBe("inferred");
    expect(flags.contested_downgrades).toBe(1);
    expect(flags.downgraded).toBe(1);
  });

  it("e) synthesizes >=1 inferred chip when validation[] is empty but cited numeric claims exist", async () => {
    const sources: Source[] = [
      { n: 1, title: "s", url: "https://x.com/p", accessed_at: "2026-05-30" },
    ];
    const blocks: Block[] = [
      { type: "exec_summary", prose_md: "The market reached $205M in 2025.", citations: [1] },
      { type: "stat_tiles", tiles: [{ value: "58%", label: "female", citation: 1 }] },
    ];
    const report = baseReport({ sources, blocks, validation: [] });
    const toolCalls = [fetchCall("https://x.com/p", "The market reached $205M; 58% female.")];

    const { report: out, flags } = await groundResearchClaims(report, toolCalls, {});

    expect(flags.chips_synthesized).toBeGreaterThanOrEqual(1);
    expect(out.validation.some((c) => c.tier === "inferred")).toBe(true);
  });

  it("f) truncation fail-closed: capped source + number absent → downgrade + high-risk chip, NO refetch", async () => {
    const adjudicate = vi.fn(async (pairs: { claim: string; sourceText: string }[]) =>
      pairs.map(() => true),
    );
    const sources: Source[] = [
      { n: 1, title: "s", url: "https://x.com/p", accessed_at: "2026-05-30" },
    ];
    const validation: ValidationChip[] = [
      { tier: "validated", text: "Fleet size is 2.66M", supporting_source_indices: [1] },
    ];
    const report = baseReport({ sources, validation });
    const toolCalls = [
      fetchCall("https://x.com/p", "Intro paragraph with no figure …[truncated 500 bytes]"),
    ];

    const { report: out, flags } = await groundResearchClaims(report, toolCalls, { adjudicate });

    expect(out.validation[0].tier).toBe("inferred");
    expect(flags.truncation_hedges).toBe(1);
    expect(out.validation.some((c) => c.tier === "high-risk" && /capped \(truncated\)/.test(c.text))).toBe(true);
    expect(adjudicate).not.toHaveBeenCalled();
  });

  it("g) NEGATIVE/regression: a well-grounded multi-source report → zero downgrades, chips unchanged", async () => {
    const adjudicate = vi.fn();
    const sources: Source[] = [
      { n: 1, title: "a", url: "https://a.com/p", accessed_at: "2026-05-30" },
      { n: 2, title: "b", url: "https://b.com/p", accessed_at: "2026-05-30" },
    ];
    const validation: ValidationChip[] = [
      { tier: "validated", text: "Adoption hit 58%", supporting_source_indices: [1, 2] },
    ];
    const report = baseReport({ sources, validation });
    const toolCalls = [
      fetchCall("https://a.com/p", "Adoption hit 58% in the latest survey."),
      fetchCall("https://b.com/p", "An independent poll also found 58% adoption."),
    ];

    const { report: out, flags } = await groundResearchClaims(report, toolCalls, { adjudicate });

    expect(out.validation[0].tier).toBe("validated");
    expect(out.validation[0].supporting_source_indices).toEqual([1, 2]);
    expect(flags.downgraded).toBe(0);
    expect(flags.stripped).toBe(0);
    expect(flags.grounded).toBe(1);
    expect(adjudicate).not.toHaveBeenCalled();
  });

  const STALE_OPTS = { stalenessMonths: 24, now: new Date("2026-06-02T00:00:00Z") };

  it("h) validated multi-source numeric chip, BOTH sources dated 2021 → chip stays validated, +1 stale high-risk chip", async () => {
    const sources: Source[] = [
      { n: 1, title: "a", url: "https://a.com/p", accessed_at: "2026-05-30" },
      { n: 2, title: "b", url: "https://b.com/p", accessed_at: "2026-05-30" },
    ];
    const validation: ValidationChip[] = [
      { tier: "validated", text: "TAM is $4.2B", supporting_source_indices: [1, 2] },
    ];
    const report = baseReport({ sources, validation });
    const toolCalls = [
      fetchCall("https://a.com/p", "Published June 2021: the TAM is $4.2B."),
      fetchCall("https://b.com/p", "As of 2021, an independent estimate also puts it at $4.2B."),
    ];

    const { report: out, flags } = await groundResearchClaims(report, toolCalls, STALE_OPTS);

    expect(out.validation[0].tier).toBe("validated");
    expect(flags.downgraded).toBe(0);
    expect(flags.stale_hedges).toBe(1);
    const stale = out.validation.filter(
      (c) => c.tier === "high-risk" && /dates to .*; may be stale/.test(c.text),
    );
    expect(stale).toHaveLength(1);
  });

  it("i) same but BOTH sources dated 2025 → no stale chip", async () => {
    const sources: Source[] = [
      { n: 1, title: "a", url: "https://a.com/p", accessed_at: "2026-05-30" },
      { n: 2, title: "b", url: "https://b.com/p", accessed_at: "2026-05-30" },
    ];
    const validation: ValidationChip[] = [
      { tier: "validated", text: "TAM is $4.2B", supporting_source_indices: [1, 2] },
    ];
    const report = baseReport({ sources, validation });
    const toolCalls = [
      fetchCall("https://a.com/p", "Published 2025: the TAM is $4.2B."),
      fetchCall("https://b.com/p", "Updated 2025, an estimate also puts it at $4.2B."),
    ];

    const { report: out, flags } = await groundResearchClaims(report, toolCalls, STALE_OPTS);

    expect(out.validation[0].tier).toBe("validated");
    expect(flags.stale_hedges).toBe(0);
  });

  it("j) same but sources carry NO date signal → no stale chip", async () => {
    const sources: Source[] = [
      { n: 1, title: "a", url: "https://a.com/p", accessed_at: "2026-05-30" },
      { n: 2, title: "b", url: "https://b.com/p", accessed_at: "2026-05-30" },
    ];
    const validation: ValidationChip[] = [
      { tier: "validated", text: "TAM is $4.2B", supporting_source_indices: [1, 2] },
    ];
    const report = baseReport({ sources, validation });
    const toolCalls = [
      fetchCall("https://a.com/p", "The TAM is $4.2B according to analysts."),
      fetchCall("https://b.com/p", "An independent estimate also puts it at $4.2B."),
    ];

    const { report: out, flags } = await groundResearchClaims(report, toolCalls, STALE_OPTS);

    expect(out.validation[0].tier).toBe("validated");
    expect(flags.stale_hedges).toBe(0);
  });

  it("k) mixed: one supporting source dated 2021, the other 2025 → a fresh source suppresses the hedge", async () => {
    const sources: Source[] = [
      { n: 1, title: "a", url: "https://a.com/p", accessed_at: "2026-05-30" },
      { n: 2, title: "b", url: "https://b.com/p", accessed_at: "2026-05-30" },
    ];
    const validation: ValidationChip[] = [
      { tier: "validated", text: "TAM is $4.2B", supporting_source_indices: [1, 2] },
    ];
    const report = baseReport({ sources, validation });
    const toolCalls = [
      fetchCall("https://a.com/p", "Published 2021: the TAM is $4.2B."),
      fetchCall("https://b.com/p", "Updated 2025: a fresher estimate confirms $4.2B."),
    ];

    const { report: out, flags } = await groundResearchClaims(report, toolCalls, STALE_OPTS);

    expect(out.validation[0].tier).toBe("validated");
    expect(flags.stale_hedges).toBe(0);
  });

  it("l) regression: well-grounded multi-source with staleness ON but undated text → inert (stale_hedges=0, chip unchanged)", async () => {
    const adjudicate = vi.fn();
    const sources: Source[] = [
      { n: 1, title: "a", url: "https://a.com/p", accessed_at: "2026-05-30" },
      { n: 2, title: "b", url: "https://b.com/p", accessed_at: "2026-05-30" },
    ];
    const validation: ValidationChip[] = [
      { tier: "validated", text: "Adoption hit 58%", supporting_source_indices: [1, 2] },
    ];
    const report = baseReport({ sources, validation });
    const toolCalls = [
      fetchCall("https://a.com/p", "Adoption hit 58% in the latest survey."),
      fetchCall("https://b.com/p", "An independent poll also found 58% adoption."),
    ];

    const { report: out, flags } = await groundResearchClaims(report, toolCalls, {
      ...STALE_OPTS,
      adjudicate,
    });

    expect(out.validation[0].tier).toBe("validated");
    expect(out.validation[0].supporting_source_indices).toEqual([1, 2]);
    expect(flags.stale_hedges).toBe(0);
    expect(flags.downgraded).toBe(0);
    expect(adjudicate).not.toHaveBeenCalled();
  });
});

describe("isFetchTrace (prod slug matching — the dead-grounding bug)", () => {
  it("matches every research fetch server's prod __ slug", () => {
    expect(isFetchTrace("web_fetch__fetch")).toBe(true);
    expect(isFetchTrace("web_search__search")).toBe(true);
    expect(isFetchTrace("competitor_intel__http_fetch")).toBe(true);
    expect(isFetchTrace("apify__rag_web_browser")).toBe(true);
    expect(isFetchTrace("apify__scrape_tiktok")).toBe(true);
  });
  it("does NOT match non-fetch prod slugs", () => {
    expect(isFetchTrace("slack__send_message")).toBe(false);
    expect(isFetchTrace("report__render_pdf")).toBe(false);
    expect(isFetchTrace("foo__search")).toBe(false);
    expect(isFetchTrace("github__read_file")).toBe(false);
  });
  it("falls back to the historical bare-name set for __-less legacy/internal traces", () => {
    expect(isFetchTrace("web_fetch")).toBe(true);
    expect(isFetchTrace("web_search")).toBe(true);
    expect(isFetchTrace("browser_fetch")).toBe(true);
    expect(isFetchTrace("slack")).toBe(false);
    expect(isFetchTrace("search")).toBe(false);
  });
});
