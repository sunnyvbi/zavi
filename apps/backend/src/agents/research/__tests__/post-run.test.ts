import { describe, it, expect } from "vitest";
import { normalizeResearchReport, detectWeakSynthesis } from "../post-run";
import type { ResearchReport } from "../output-schema";

function baseReport(over: Partial<ResearchReport> = {}): ResearchReport {
  return {
    kind: "report",
    template: "landscape",
    title: "T",
    query: "ask",
    blocks: [{ type: "exec_summary", prose_md: "summary", citations: [1] }],
    lenses: [],
    sources: [{ n: 1, title: "s", url: "https://a.com", accessed_at: "2026-05-20" }],
    validation: [{ tier: "inferred", text: "x", supporting_source_indices: [1] }],
    failed_lenses: [],
    generated_at: "2026-05-20T00:00:00Z",
    ...over,
  };
}

describe("normalizeResearchReport", () => {
  it("drops citation indices that point outside sources[]", () => {
    const r = baseReport({ blocks: [{ type: "exec_summary", prose_md: "s", citations: [1, 99] }] });
    const { report, droppedCitations } = normalizeResearchReport(r);
    const block = report.blocks[0] as { citations: number[] };
    expect(block.citations).toEqual([1]);
    expect(droppedCitations).toBe(1);
  });

  it("drops an out-of-range singular citation on exec_summary stat tiles", () => {
    const r = baseReport({
      blocks: [{ type: "exec_summary", prose_md: "s", citations: [1], stat_tiles: [{ value: "10k", label: "users", citation: 99 }] }],
    });
    const { report, droppedCitations } = normalizeResearchReport(r);
    const block = report.blocks[0] as { stat_tiles: { citation?: number }[] };
    expect(block.stat_tiles[0].citation).toBeUndefined();
    expect(droppedCitations).toBe(1);
  });

  it("drops an out-of-range citation on a standalone stat_tiles block", () => {
    const r = baseReport({ blocks: [{ type: "stat_tiles", tiles: [{ value: "5", label: "x", citation: 42 }] }] });
    const { report } = normalizeResearchReport(r);
    const block = report.blocks[0] as { tiles: { citation?: number }[] };
    expect(block.tiles[0].citation).toBeUndefined();
  });

  it("downgrades a 'validated' chip with zero supporting sources to 'inferred'", () => {
    const r = baseReport({ validation: [{ tier: "validated", text: "claim", supporting_source_indices: [] }] });
    const { report, downgradedChips } = normalizeResearchReport(r);
    expect(report.validation[0].tier).toBe("inferred");
    expect(downgradedChips).toBe(1);
  });

  it("keeps a 'validated' chip that cites a real source", () => {
    const r = baseReport({ validation: [{ tier: "validated", text: "claim", supporting_source_indices: [1] }] });
    const { report } = normalizeResearchReport(r);
    expect(report.validation[0].tier).toBe("validated");
  });

  it("injects a high-risk chip when a lens is poisoned", () => {
    const r = baseReport({
      lenses: [
        { lens: "reviews", label: "Reviews", takeaways: [], prose_md: "", sources: [], provenance: { fetched_urls: [], fetch_errors: 0, poisoned: true, reason: "injection" } },
      ],
    });
    const { report } = normalizeResearchReport(r);
    expect(report.validation.some((c) => c.tier === "high-risk" && /reviews/i.test(c.text))).toBe(true);
  });

  it("is a no-op passthrough for a clean report", () => {
    const r = baseReport();
    const { report, droppedCitations, downgradedChips } = normalizeResearchReport(r);
    expect(droppedCitations).toBe(0);
    expect(downgradedChips).toBe(0);
    expect(report.blocks).toEqual(r.blocks);
  });
});

describe("detectWeakSynthesis (P1.3 telemetry, calibrated to customer-intel only)", () => {
  it("flags a customer-intel report with no recommendations/gap_list block", () => {
    const r = baseReport({
      template: "customer-intel",
      blocks: [{ type: "exec_summary", prose_md: "facts", citations: [1] }],
    });
    expect(detectWeakSynthesis(r)).toBe(true);
  });

  it("does NOT flag a customer-intel report that HAS a recommendations block", () => {
    const r = baseReport({
      template: "customer-intel",
      blocks: [
        { type: "exec_summary", prose_md: "facts", citations: [1] },
        { type: "recommendations", items: [{ index: 1, label: "do", title: "Ship X", body_md: "because", citations: [1] }] },
      ],
    });
    expect(detectWeakSynthesis(r)).toBe(false);
  });

  it("does NOT flag a competitor-teardown with no recommendations/gap_list", () => {
    const r = baseReport({
      template: "competitor-teardown",
      blocks: [{ type: "exec_summary", prose_md: "facts", citations: [1] }],
    });
    expect(detectWeakSynthesis(r)).toBe(false);
  });
});
