import { describe, it, expect } from "vitest";
import {
  isPlaceholderStubLine,
  lintMarkdownPlaceholders,
  lintArtifactSections,
} from "../placeholder-lint";
import { buildResearchPdfInput } from "@/agents/research/pdf-input";
import type { ResearchReport } from "@/agents/research/output-schema";

describe("isPlaceholderStubLine", () => {
  it("matches the prod 816cea18 stub shapes", () => {
    expect(isPlaceholderStubLine("1. 1 —")).toBe(true);
    expect(isPlaceholderStubLine("2. 2 —")).toBe(true);
    expect(isPlaceholderStubLine("  3. —")).toBe(true);
    expect(isPlaceholderStubLine("1. -")).toBe(true);
    expect(isPlaceholderStubLine("12. 12 – ")).toBe(true);
    expect(isPlaceholderStubLine("**1. 1 — **")).toBe(true);
    expect(isPlaceholderStubLine("**1.  — **")).toBe(true);
  });

  it("does not match real numbered content", () => {
    expect(isPlaceholderStubLine("1. Ship the referral program — gate on activation")).toBe(false);
    expect(isPlaceholderStubLine("1. **P0** — fix onboarding drop-off")).toBe(false);
    expect(isPlaceholderStubLine("2. 100% — conversion target")).toBe(false);
    expect(isPlaceholderStubLine("- bullet item")).toBe(false);
    expect(isPlaceholderStubLine("Plain prose line.")).toBe(false);
    expect(isPlaceholderStubLine("")).toBe(false);
  });
});

describe("lintMarkdownPlaceholders", () => {
  it("strips numbered stub lines and counts them", () => {
    const md = "**1. 1 — **\n\n**2. 2 — **\n\nReal closing prose.";
    const { text, flags } = lintMarkdownPlaceholders(md);
    expect(flags.stub_lines).toBe(2);
    expect(text).toBe("Real closing prose.");
  });

  it("strips headings whose body until the next heading is empty", () => {
    const md = "## Notes\n\n## Findings\n\nActual findings here.\n\n## Validation\n\n";
    const { text, flags } = lintMarkdownPlaceholders(md);
    expect(flags.empty_sections).toBe(2);
    expect(text).toContain("## Findings");
    expect(text).toContain("Actual findings here.");
    expect(text).not.toContain("## Notes");
    expect(text).not.toContain("## Validation");
  });

  it("leaves clean markdown untouched (modulo trim)", () => {
    const md = "## Recommendations\n\n1. **Ship X** — because Y. [1]";
    const { text, flags } = lintMarkdownPlaceholders(md);
    expect(flags).toEqual({ stub_lines: 0, empty_sections: 0 });
    expect(text).toBe(md);
  });
});

describe("lintArtifactSections", () => {
  it("drops table-less sections whose body is a bare dash placeholder", () => {
    const { sections, flags } = lintArtifactSections([
      { heading: "Notes", body_markdown: "—" },
      { heading: "Findings", body_markdown: "Real content." },
    ]);
    expect(sections.map((s) => s.heading)).toEqual(["Findings"]);
    expect(flags.empty_sections).toBe(1);
  });

  it("drops a section whose body is ONLY stub lines (the 816cea18 shape)", () => {
    const { sections, flags } = lintArtifactSections([
      { heading: "Recommendations", body_markdown: "**1. 1 — **\n\n**2. 2 — **" },
    ]);
    expect(sections).toEqual([]);
    expect(flags.stub_lines).toBe(2);
    expect(flags.empty_sections).toBe(1);
  });

  it("strips stub lines but keeps a section with surviving real content", () => {
    const { sections, flags } = lintArtifactSections([
      {
        heading: "Recommendations",
        body_markdown: "**1. P0 — Fix onboarding**\nDo the thing. [2]\n\n**2. 2 — **",
      },
    ]);
    expect(sections).toHaveLength(1);
    expect(sections[0].body_markdown).toContain("Fix onboarding");
    expect(sections[0].body_markdown).not.toContain("2. 2 —");
    expect(flags.stub_lines).toBe(1);
  });

  it("keeps table sections even with an empty body", () => {
    const { sections } = lintArtifactSections([
      {
        heading: "Competitive landscape",
        body_markdown: "",
        table: { columns: ["Brand"], rows: [["Acme"]] },
      },
    ]);
    expect(sections).toHaveLength(1);
  });

  it("end-to-end: stub recommendations + empty notes/validation blocks never reach the PDF", () => {
    const report = {
      kind: "report",
      template: "freeform",
      title: "Library report",
      query: "q",
      blocks: [
        { type: "exec_summary", prose_md: "Bottom line: do X. [1]", citations: [1] },
        {
          type: "recommendations",
          items: [
            { index: 1, label: "1", title: "", body_md: "", citations: [] },
            { index: 2, label: "2", title: "", body_md: "", citations: [] },
          ],
        },
        { type: "markdown", body_md: "" },
        { type: "validation", chips: [] },
      ],
      lenses: [],
      sources: [
        { n: 1, title: "Src", url: "https://example.com", accessed_at: "2026-06-10" },
      ],
      validation: [],
      failed_lenses: [],
      generated_at: "2026-06-10T00:00:00Z",
    } as unknown as ResearchReport;

    const input = buildResearchPdfInput(report);
    const { sections, flags } = lintArtifactSections(input.sections);
    const headings = sections.map((s) => s.heading);
    expect(headings).not.toContain("Recommendations");
    expect(headings).not.toContain("Notes");
    expect(headings).not.toContain("Validation");
    expect(headings).toContain("Executive summary");
    expect(flags.stub_lines).toBeGreaterThan(0);
    expect(flags.empty_sections).toBeGreaterThan(0);
    const exec = sections.find((s) => s.heading === "Executive summary");
    expect(exec?.body_markdown).toContain("Bottom line: do X.");
  });
});
