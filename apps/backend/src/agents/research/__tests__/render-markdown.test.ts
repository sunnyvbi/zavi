import { describe, it, expect } from "vitest";
import { renderResearchReportMarkdown, detectProseOnly } from "../render-markdown";

const base = {
  kind: "report" as const,
  template: "competitor-teardown" as const,
  title: "Upcar Competitive Analysis",
  subtitle: "P2P car rental",
  query: "competitors",
  lenses: [],
  validation: [],
  failed_lenses: [],
  generated_at: "2026-05-30T00:00:00Z",
};

describe("renderResearchReportMarkdown", () => {
  it("renders title, subtitle, exec_summary, competitive_table, recommendations, sources", () => {
    const report: any = {
      ...base,
      blocks: [
        { type: "exec_summary", prose_md: "Turo is the lone survivor.", citations: [1] },
        { type: "competitive_table", rows: [{ brand: "Turo", price: "$50/day", positioning: "incumbent", gap: "fee opacity", citations: [1] }] },
        { type: "recommendations", items: [{ index: 1, label: "P0", title: "Capture refugees", body_md: "Target former Getaround hosts.", citations: [2] }] },
      ],
      sources: [
        { n: 1, title: "TechCrunch", url: "https://tc.com", accessed_at: "2026-05-30" },
        { n: 2, title: "Sacra", url: "https://sacra.com", accessed_at: "2026-05-30" },
      ],
    };
    const md = renderResearchReportMarkdown(report);
    expect(md).toContain("# Upcar Competitive Analysis");
    expect(md).toContain("_P2P car rental_");
    expect(md).toContain("## Executive summary");
    expect(md).toContain("Turo is the lone survivor.");
    expect(md).toContain("| Brand | Price | Positioning | Gap |");
    expect(md).toContain("| Turo | $50/day | incumbent | fee opacity |");
    expect(md).toContain("1. **P0** — Capture refugees");
    expect(md).toContain("## Sources");
    expect(md).toContain("[TechCrunch](https://tc.com)");
    expect(md).not.toContain('"kind"');
  });

  it("escapes pipes/newlines in table cells so columns don't corrupt", () => {
    const report: any = {
      ...base,
      blocks: [{ type: "competitive_table", rows: [{ brand: "A|B", price: "$1\n/day", positioning: "x", gap: "y", citations: [] }] }],
      sources: [],
    };
    const md = renderResearchReportMarkdown(report);
    expect(md).toContain("A\\|B");
    expect(md).not.toContain("$1\n/day");
    const tableLine = md.split("\n").find((l) => l.includes("A\\|B"))!;
    expect((tableLine.match(/\|/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });

  it("does not duplicate Sources when a source_list block is present", () => {
    const report: any = {
      ...base,
      blocks: [{ type: "source_list", sources: [{ n: 1, title: "TC", url: "https://tc.com", accessed_at: "2026-05-30" }] }],
      sources: [{ n: 1, title: "TC", url: "https://tc.com", accessed_at: "2026-05-30" }],
    };
    const md = renderResearchReportMarkdown(report);
    expect(md.match(/## Sources/g) ?? []).toHaveLength(0);
    expect((md.match(/TC/g) ?? []).length).toBe(1);
  });

  it("strips a ```json {\"tiles\"} blob the model embedded in prose (qa-blind TC1)", () => {
    const report: any = {
      ...base,
      blocks: [
        { type: "exec_summary", prose_md: "Turo leads.\n\n```json\n{\"tiles\":[{\"label\":\"rev\",\"value\":\"$958M\"}]}\n```\n\nThat is the picture.", citations: [1] },
      ],
      sources: [{ n: 1, title: "TC", url: "https://a.com", accessed_at: "2026-05-30" }],
    };
    const md = renderResearchReportMarkdown(report);
    expect(md).not.toContain('"tiles"');
    expect(md).not.toContain("```json");
    expect(md).toContain("Turo leads.");
    expect(md).toContain("That is the picture.");
  });

  it("strips every model-leaked json blob shape but keeps the prose around it", () => {
    const report: any = {
      ...base,
      blocks: [
        { type: "exec_summary", prose_md: "Turo leads.\n\n```json\n{\"headline\":\"X\",\"subhead\":\"Y\",\"citations\":[1]}\n```\n\nThat is the picture.", citations: [1] },
        { type: "markdown", body_md: "Risks:\n```json\n{\"items\":[{\"title\":\"fee opacity\"}]}\n```" },
        { type: "markdown", body_md: "Stats:\n```json\n{\"tiles\":[{\"value\":\"$958M\"}]}\n```" },
      ],
      sources: [{ n: 1, title: "TC", url: "https://a.com", accessed_at: "2026-05-30" }],
    };
    const md = renderResearchReportMarkdown(report);
    expect(md).not.toContain('"headline"');
    expect(md).not.toContain('"items"');
    expect(md).not.toContain('"tiles"');
    expect(md).not.toContain("```json");
    expect(md).toContain("Turo leads.");
    expect(md).toContain("That is the picture.");
  });

  it("emits NO markdown heading lines when proseOnly is set", () => {
    const report: any = {
      ...base,
      blocks: [
        { type: "exec_summary", prose_md: "Turo is the lone survivor.", citations: [1] },
        { type: "persona_cards", cards: [{ name: "Olivia", tagline: "frequent renter", fields: { primary_need: "a", pain_point: "b", behavior: "c", valued_feature: "d" }, buy_likelihood: 4, commentary_md: "notes", citations: [1] }] },
        { type: "cards_grid", cards: [{ title: "Gap A", body_md: "body", citations: [1] }] },
        { type: "gap_list", items: [{ category: "P0", title: "Refugees", body_md: "body", citations: [1] }] },
        { type: "table", title: "Pricing", columns: ["A", "B"], rows: [["1", "2"]], citations: [] },
      ],
      sources: [{ n: 1, title: "TC", url: "https://tc.com", accessed_at: "2026-05-30" }],
    };
    const md = renderResearchReportMarkdown(report, { proseOnly: true });
    const headingLines = md.split("\n").filter((l) => /^#{1,6}\s/.test(l));
    expect(headingLines).toEqual([]);
    expect(md).toContain("**Upcar Competitive Analysis**");
    expect(md).toContain("Turo is the lone survivor.");
    expect(md).toContain("**Sources**");
    expect(md).not.toContain("## Executive summary");
  });

  it("still emits headings by default (proseOnly off)", () => {
    const report: any = {
      ...base,
      blocks: [{ type: "exec_summary", prose_md: "Turo leads.", citations: [1] }],
      sources: [{ n: 1, title: "TC", url: "https://tc.com", accessed_at: "2026-05-30" }],
    };
    const md = renderResearchReportMarkdown(report);
    expect(md).toContain("# Upcar Competitive Analysis");
    expect(md).toContain("## Executive summary");
    expect(md).toContain("## Sources");
  });

  it("detectProseOnly matches explicit no-headings / prose-only asks only", () => {
    expect(detectProseOnly("Give me a prose only summary")).toBe(true);
    expect(detectProseOnly("write this with no headings please")).toBe(true);
    expect(detectProseOnly("no markdown, just text")).toBe(true);
    expect(detectProseOnly("answer in one paragraph")).toBe(true);
    expect(detectProseOnly("Who are Turo's competitors?")).toBe(false);
    expect(detectProseOnly("")).toBe(false);
    expect(detectProseOnly(undefined)).toBe(false);
  });

  it("does not strip a non-json code fence", () => {
    const report: any = {
      ...base,
      blocks: [{ type: "markdown", body_md: "Run:\n```bash\nnpm run build\n```" }],
      sources: [],
    };
    const md = renderResearchReportMarkdown(report);
    expect(md).toContain("npm run build");
  });

});
