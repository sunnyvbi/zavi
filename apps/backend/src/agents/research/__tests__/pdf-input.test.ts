import { describe, it, expect } from "vitest";
import { buildResearchPdfInput } from "../pdf-input";
import { renderPdfInputSchema } from "@/services/reports/schema";

const base = {
  kind: "report" as const,
  template: "competitor-teardown" as const,
  title: "Upcar Competitive Analysis",
  query: "competitors",
  lenses: [],
  validation: [],
  failed_lenses: [],
  generated_at: "2026-05-30T00:00:00Z",
};

describe("buildResearchPdfInput", () => {
  it("produces a schema-valid render_pdf input with a native table", () => {
    const report: any = {
      ...base,
      blocks: [
        { type: "exec_summary", prose_md: "Turo is the lone survivor.", citations: [1] },
        { type: "competitive_table", rows: [{ brand: "Turo", price: "$50/day", positioning: "incumbent", gap: "fee opacity", citations: [1] }] },
        { type: "recommendations", items: [{ index: 1, label: "P0", title: "Capture refugees", body_md: "Target former Getaround hosts.", citations: [2] }] },
      ],
      sources: [{ n: 1, title: "TC", url: "https://a.com", accessed_at: "2026-05-30" }],
    };
    const input = buildResearchPdfInput(report);
    expect(() => renderPdfInputSchema.parse(input)).not.toThrow();
    expect(input.filename).toBe("upcar-competitive-analysis.pdf");
    const tbl = input.sections.find((s) => s.table)!;
    expect(tbl.table!.columns).toHaveLength(4);
    expect(tbl.table!.rows[0]).toHaveLength(4);
  });

  it("always yields at least one section even with no blocks", () => {
    const report: any = { ...base, blocks: [], sources: [] };
    const input = buildResearchPdfInput(report);
    expect(() => renderPdfInputSchema.parse(input)).not.toThrow();
    expect(input.sections.length).toBeGreaterThanOrEqual(1);
  });

  it("pads jagged generic-table rows so the schema accepts them", () => {
    const report: any = {
      ...base,
      blocks: [{ type: "table", columns: ["A", "B", "C"], rows: [["1"], ["2", "3", "4"]], citations: [] }],
      sources: [],
    };
    const input = buildResearchPdfInput(report);
    expect(() => renderPdfInputSchema.parse(input)).not.toThrow();
  });

  it("degrades an empty-column generic table to prose (schema-valid)", () => {
    const report: any = {
      ...base,
      blocks: [{ type: "table", columns: [], rows: [["a", "b"]], citations: [] }, { type: "markdown", body_md: "x" }],
      sources: [],
    };
    expect(() => renderPdfInputSchema.parse(buildResearchPdfInput(report))).not.toThrow();
  });

  it("normalizes empty optional headings (theme_bars/table title === '')", () => {
    const report: any = {
      ...base,
      blocks: [
        { type: "theme_bars", title: "", bars: [{ label: "L", pct: 50, citations: [] }] },
        { type: "table", title: "", columns: ["A"], rows: [["1"]], citations: [] },
      ],
      sources: [],
    };
    expect(() => renderPdfInputSchema.parse(buildResearchPdfInput(report))).not.toThrow();
  });

  it("keeps total prose under the 50KB schema budget for a long report", () => {
    const big = "x".repeat(9000);
    const report: any = { ...base, blocks: Array.from({ length: 20 }, () => ({ type: "markdown", body_md: big })), sources: [] };
    const input = buildResearchPdfInput(report);
    expect(() => renderPdfInputSchema.parse(input)).not.toThrow();
  });

  it("skips an oversized first table but preserves later blocks (no full content loss)", () => {
    const bigTable = { type: "table", columns: ["A", "B"], rows: Array.from({ length: 30 }, () => ["x".repeat(500), "y".repeat(500)]), citations: [] };
    const report: any = { ...base, blocks: [bigTable, { type: "markdown", body_md: "keep me" }], sources: [] };
    const input = buildResearchPdfInput(report);
    expect(() => renderPdfInputSchema.parse(input)).not.toThrow();
    expect(JSON.stringify(input.sections)).toContain("keep me");
  });

  it("strips model-leaked json blobs from PDF section bodies (qa-blind re-run)", () => {
    const report: any = {
      ...base,
      blocks: [
        { type: "exec_summary", prose_md: "Real prose.\n\n```json\n{\"headline\":\"X\",\"items\":[1]}\n```\n\nMore prose.", citations: [1] },
      ],
      sources: [{ n: 1, title: "TC", url: "https://a.com", accessed_at: "2026-05-30" }],
    };
    const input = buildResearchPdfInput(report);
    const body = input.sections.map((sec) => sec.body_markdown).join("\n");
    expect(body).not.toContain('"headline"');
    expect(body).not.toContain("```json");
    expect(body).toContain("Real prose.");
    expect(() => renderPdfInputSchema.parse(input)).not.toThrow();
  });

  it("appends top-level report.sources as a Sources section when no source_list block exists", () => {
    const sources = Array.from({ length: 20 }, (_, i) => ({
      n: i + 1,
      title: `Source ${i + 1}`,
      url: `https://example.com/${i + 1}`,
      accessed_at: "2026-05-30",
    }));
    const report: any = {
      ...base,
      blocks: [
        { type: "exec_summary", prose_md: "Summary prose.", citations: [1] },
        { type: "markdown", body_md: "Some notes.", citations: [2] },
      ],
      sources,
    };
    const input = buildResearchPdfInput(report);
    expect(() => renderPdfInputSchema.parse(input)).not.toThrow();
    const srcSection = input.sections.find((s) => s.heading === "Sources");
    expect(srcSection).toBeTruthy();
    expect(srcSection!.body_markdown).toContain("Source 1");
    expect(srcSection!.body_markdown).toContain("Source 20");
  });

  it("does NOT double-render sources when a source_list block already exists", () => {
    const report: any = {
      ...base,
      blocks: [
        { type: "exec_summary", prose_md: "Summary.", citations: [1] },
        { type: "source_list", sources: [{ n: 1, title: "In-block", url: "https://b.com", accessed_at: "2026-05-30" }] },
      ],
      sources: [{ n: 1, title: "Top-level", url: "https://a.com", accessed_at: "2026-05-30" }],
    };
    const input = buildResearchPdfInput(report);
    const sourceSections = input.sections.filter((s) => s.heading === "Sources");
    expect(sourceSections).toHaveLength(1);
    expect(sourceSections[0].body_markdown).toContain("In-block");
    expect(sourceSections[0].body_markdown).not.toContain("Top-level");
  });
});
