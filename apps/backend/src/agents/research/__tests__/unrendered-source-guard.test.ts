
import { describe, it, expect } from "vitest";
import { guardUnrenderedSources, type UnverifiedCapture } from "../unrendered-source-guard";
import type { ResearchReport } from "../output-schema";
import type { Block, Source, ValidationChip } from "../blocks";

function baseReport(over: Partial<ResearchReport> = {}): ResearchReport {
  return {
    kind: "report",
    template: "competitor-teardown",
    title: "T",
    query: "ask",
    blocks: [{ type: "exec_summary", prose_md: "summary", citations: [1] }],
    lenses: [],
    sources: [{ n: 1, title: "s1", url: "https://turo.com/", accessed_at: "2026-06-04" }],
    validation: [],
    failed_lenses: [],
    generated_at: "2026-06-04T00:00:00Z",
    ...over,
  };
}

describe("guardUnrenderedSources", () => {
  it("downgrades a validated chip that cites an unrendered (blocked) source + name-discloses it", () => {
    const sources: Source[] = [
      { n: 1, title: "turo", url: "https://turo.com/", accessed_at: "2026-06-04" },
      { n: 2, title: "good", url: "https://rendered.example/", accessed_at: "2026-06-04" },
    ];
    const validation: ValidationChip[] = [
      { tier: "validated", text: "Turo's homepage headline is 'Rental reinvented'", supporting_source_indices: [1] },
      { tier: "validated", text: "Rendered page says X", supporting_source_indices: [2] },
    ];
    const report = baseReport({ sources, validation });
    const unverified: UnverifiedCapture[] = [
      { requested_url: "https://turo.com/", final_url: "https://turo.com/", capture: "blocked" },
    ];

    const { report: out, flags } = guardUnrenderedSources(report, unverified);

    const turoChip = out.validation.find((c) => c.text.includes("Rental reinvented"))!;
    expect(turoChip.tier).toBe("high-risk");
    expect(turoChip.supporting_source_indices).toEqual([]);
    const okChip = out.validation.find((c) => c.text === "Rendered page says X")!;
    expect(okChip.tier).toBe("validated");
    expect(okChip.supporting_source_indices).toEqual([2]);
    const disclosure = out.validation.find(
      (c) => c.tier === "high-risk" && /could not load https:\/\/turo\.com/i.test(c.text),
    );
    expect(disclosure).toBeDefined();
    expect(flags.unrendered_sources).toBe(1);
    expect(flags.chips_downgraded).toBe(1);
    expect(flags.disclosure_chips_added).toBe(1);
    expect(flags.citations_stripped).toBe(2);
    const exec = out.blocks.find((b) => b.type === "exec_summary") as Extract<Block, { type: "exec_summary" }>;
    expect(exec.citations).toEqual([]);
  });

  it("strips the unrendered source's citation index from block claims", () => {
    const blocks: Block[] = [
      { type: "exec_summary", prose_md: "Turo positions premium [1]; Getaround budget [2].", citations: [1, 2] },
      {
        type: "competitive_table",
        rows: [
          { brand: "Turo", positioning: "premium", gap: "fees", citations: [1] },
          { brand: "Getaround", positioning: "budget", gap: "supply", citations: [2] },
        ],
      },
    ];
    const sources: Source[] = [
      { n: 1, title: "turo", url: "https://turo.com/", accessed_at: "2026-06-04" },
      { n: 2, title: "getaround", url: "https://getaround.example/", accessed_at: "2026-06-04" },
    ];
    const report = baseReport({ blocks, sources });
    const unverified: UnverifiedCapture[] = [
      { requested_url: "https://turo.com/", final_url: "https://turo.com/", capture: "empty_shell" },
    ];

    const { report: out } = guardUnrenderedSources(report, unverified);

    const exec = out.blocks.find((b) => b.type === "exec_summary") as Extract<Block, { type: "exec_summary" }>;
    expect(exec.citations).toEqual([2]);
    const table = out.blocks.find((b) => b.type === "competitive_table") as Extract<Block, { type: "competitive_table" }>;
    expect(table.rows[0].citations).toEqual([]);
    expect(table.rows[1].citations).toEqual([2]);
  });

  it("no-op when no cited source is unrendered (all captures rendered)", () => {
    const report = baseReport({
      validation: [{ tier: "validated", text: "ok", supporting_source_indices: [1] }],
    });
    const { report: out, flags } = guardUnrenderedSources(report, []);
    expect(out.validation[0].tier).toBe("validated");
    expect(flags.unrendered_sources).toBe(0);
  });

  it("matches the source by final_url too (post-redirect) and normalizes www", () => {
    const sources: Source[] = [
      { n: 1, title: "upcar", url: "https://upcar.ai/", accessed_at: "2026-06-04" },
    ];
    const validation: ValidationChip[] = [
      { tier: "inferred", text: "Upcar headline is 'The way 10,000+ people rent cars now'", supporting_source_indices: [1] },
    ];
    const report = baseReport({ sources, validation });
    const unverified: UnverifiedCapture[] = [
      { requested_url: "https://upcar.ai/", final_url: "https://www.upcar.ai/", capture: "empty_shell" },
    ];
    const { report: out, flags } = guardUnrenderedSources(report, unverified);
    expect(out.validation[0].tier).toBe("high-risk");
    expect(flags.unrendered_sources).toBe(1);
  });
});
