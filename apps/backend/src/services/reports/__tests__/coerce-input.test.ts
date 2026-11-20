import { describe, it, expect } from "vitest";
import { coerceRenderPdfInput, renderPdfInputSchemaCoerced } from "../coerce-input";
import { renderPdfInputSchema } from "../schema";

const parses = (raw: unknown) =>
  expect(() => renderPdfInputSchema.parse(coerceRenderPdfInput(raw))).not.toThrow();

describe("coerceRenderPdfInput", () => {
  it("brings oversized prose (>50KB total) under the schema budget", () => {
    parses({ title: "T", filename: "f.pdf", sections: Array.from({ length: 30 }, () => ({ heading: "H", body_markdown: "x".repeat(9000) })) });
  });
  it("repairs jagged rows and degrades empty-column tables", () => {
    parses({
      title: "T", filename: "f.pdf", sections: [
        { heading: "A", body_markdown: "", table: { columns: ["a", "b", "c"], rows: [["1"], ["2", "3", "4", "5"]] } },
        { heading: "B", body_markdown: "", table: { columns: [], rows: [["x", "y"]] } },
      ],
    });
  });
  it("defaults empty headings and empty title", () => {
    parses({ title: "", filename: "f.pdf", sections: [{ heading: "", body_markdown: "hi" }] });
  });
  it("caps >20 sections", () => {
    parses({ title: "T", filename: "f.pdf", sections: Array.from({ length: 40 }, () => ({ heading: "H", body_markdown: "y" })) });
  });
  it("derives a title-based filename when the model omits one (no generic report.pdf)", () => {
    const out = coerceRenderPdfInput({ title: "Q1 Revenue Recap!", sections: [{ heading: "H", body_markdown: "y" }] }) as { filename: string };
    expect(out.filename).toBe("q1-revenue-recap.pdf");
  });
  it("falls back to report.pdf only when the title has no slug-able chars", () => {
    const out = coerceRenderPdfInput({ title: "！！！", sections: [{ heading: "H", body_markdown: "y" }] }) as { filename: string };
    expect(out.filename).toBe("report.pdf");
  });
  it("keeps a model-supplied filename over the title-derived default", () => {
    const out = coerceRenderPdfInput({ title: "Q1 Recap", filename: "custom.pdf", sections: [{ heading: "H", body_markdown: "y" }] }) as { filename: string };
    expect(out.filename).toBe("custom.pdf");
  });
  it("DISCLOSES truncation in the footer when the budget drops/clips content (S6b)", () => {
    const dropped = coerceRenderPdfInput({
      title: "T", filename: "f.pdf",
      sections: Array.from({ length: 40 }, (_, i) => ({ heading: `H${i}`, body_markdown: "y" })),
    }) as { footer?: string };
    expect(dropped.footer).toMatch(/shortened to fit/i);
    const clipped = coerceRenderPdfInput({
      title: "T", filename: "f.pdf", footer: "Q1 report",
      sections: Array.from({ length: 12 }, () => ({ heading: "H", body_markdown: "x".repeat(9000) })),
    }) as { footer?: string };
    expect(clipped.footer).toMatch(/shortened to fit/i);
    expect(clipped.footer).toMatch(/Q1 report/);
  });
  it("keeps the truncation notice intact even when the base footer is near the cap (S6b edge)", () => {
    const out = coerceRenderPdfInput({
      title: "T", filename: "f.pdf", footer: "F".repeat(490),
      sections: Array.from({ length: 40 }, (_, i) => ({ heading: `H${i}`, body_markdown: "y" })),
    }) as { footer?: string };
    expect(out.footer).toMatch(/shortened to fit/i);
    expect((out.footer ?? "").length).toBeLessThanOrEqual(500);
  });
  it("does NOT add a truncation notice when everything fits", () => {
    const ok = coerceRenderPdfInput({
      title: "T", filename: "f.pdf", footer: "Q1 report",
      sections: [{ heading: "H", body_markdown: "short body" }],
    }) as { footer?: string };
    expect(ok.footer).toBe("Q1 report");
  });
  it("does NOT fabricate content for empty sections — leaves it for the strict parse to reject", () => {
    expect(coerceRenderPdfInput({ title: "T", filename: "f.pdf", sections: [] })).toEqual({ title: "T", filename: "f.pdf", sections: [] });
    expect(() => renderPdfInputSchema.parse(coerceRenderPdfInput({ title: "T", filename: "f.pdf", sections: [] }))).toThrow();
  });
  it("leaves wrong-type title untouched so strict parse rejects it (report.test.ts regression guard)", () => {
    expect(() => renderPdfInputSchema.parse(coerceRenderPdfInput({ title: 123 }))).toThrow();
  });
  it("defaults a missing filename", () => {
    parses({ title: "T", sections: [{ heading: "H", body_markdown: "y" }] });
  });
  it("leaves already-valid input parseable (no-op safe)", () => {
    parses({ title: "T", filename: "good.pdf", sections: [{ heading: "H", body_markdown: "clean" }] });
  });
  it("passes a non-object through to the strict parse (which still rejects garbage)", () => {
    expect(() => renderPdfInputSchema.parse(coerceRenderPdfInput("garbage"))).toThrow();
  });

  it("the coerced tool schema repairs oversized/jagged input (MCP-path fix, P1)", () => {
    const bad = { title: "T", filename: "f.pdf", sections: Array.from({ length: 30 }, () => ({ heading: "", body_markdown: "x".repeat(9000), table: { columns: ["a", "b"], rows: [["1"]] } })) };
    expect(() => renderPdfInputSchemaCoerced.parse(bad)).not.toThrow();
  });
  it("drops malformed passthrough fields so they can't fail the strict parse (P2)", () => {
    const out = coerceRenderPdfInput({ title: "T", filename: "f.pdf", sections: [{ heading: "H", body_markdown: "y" }], channel_id: 123, thread_ts: {}, title_metadata: "nope" }) as Record<string, unknown>;
    expect(out.channel_id).toBeUndefined();
    expect(out.thread_ts).toBeUndefined();
    expect(out.title_metadata).toBeUndefined();
    parses({ title: "T", filename: "f.pdf", sections: [{ heading: "H", body_markdown: "y" }], channel_id: 123 });
  });
  it("preserves valid string passthrough fields", () => {
    const out = coerceRenderPdfInput({ title: "T", filename: "f.pdf", sections: [{ heading: "H", body_markdown: "y" }], channel_id: "C123", thread_ts: "99.1", title_metadata: { author: "me", subject: "s" } }) as { channel_id: string; thread_ts: string; title_metadata: { author: string } };
    expect(out.channel_id).toBe("C123");
    expect(out.thread_ts).toBe("99.1");
    expect(out.title_metadata.author).toBe("me");
  });

  it("preserves a valid image_concept string on a section", () => {
    const out = coerceRenderPdfInput({
      title: "T", filename: "f.pdf",
      sections: [{ heading: "Logo #1", body_markdown: "A wordmark exploration.", image_concept: "minimal navy wordmark on cream" }],
    }) as { sections: Array<{ image_concept?: string }> };
    expect(out.sections[0].image_concept).toBe("minimal navy wordmark on cream");
  });
  it("clips an oversized image_concept to MAX (≤1000)", () => {
    const long = "x".repeat(1500);
    const out = coerceRenderPdfInput({
      title: "T", filename: "f.pdf",
      sections: [{ heading: "H", body_markdown: "y", image_concept: long }],
    }) as { sections: Array<{ image_concept?: string }> };
    expect(out.sections[0].image_concept?.length).toBe(1000);
  });
  it("drops a non-string image_concept (never propagates to the strict parse)", () => {
    const out = coerceRenderPdfInput({
      title: "T", filename: "f.pdf",
      sections: [{ heading: "H", body_markdown: "y", image_concept: 42 }],
    }) as { sections: Array<{ image_concept?: string }> };
    expect(out.sections[0].image_concept).toBeUndefined();
    parses({
      title: "T", filename: "f.pdf",
      sections: [{ heading: "H", body_markdown: "y", image_concept: 42 }],
    });
  });
  it("drops an empty or whitespace-only image_concept", () => {
    const outEmpty = coerceRenderPdfInput({
      title: "T", filename: "f.pdf",
      sections: [{ heading: "H", body_markdown: "y", image_concept: "" }],
    }) as { sections: Array<{ image_concept?: string }> };
    expect(outEmpty.sections[0].image_concept).toBeUndefined();
    const outWs = coerceRenderPdfInput({
      title: "T", filename: "f.pdf",
      sections: [{ heading: "H", body_markdown: "y", image_concept: "   " }],
    }) as { sections: Array<{ image_concept?: string }> };
    expect(outWs.sections[0].image_concept).toBeUndefined();
    parses({
      title: "T", filename: "f.pdf",
      sections: [{ heading: "H", body_markdown: "y", image_concept: "" }],
    });
  });
});

describe("table rows arrive in more than one shape", () => {
  const table = (rows: unknown) => ({
    title: "T",
    filename: "f.pdf",
    sections: [{ heading: "H", body_markdown: "b", table: { columns: ["A", "B"], rows } }],
  });
  const rowsOf = (out: unknown) =>
    ((out as { sections: Array<{ table?: { rows: string[][] } }> }).sections[0].table?.rows) ?? [];

  it("keeps cells given as {cells:[...]}", () => {
    const out = coerceRenderPdfInput(table([{ cells: ["one", "two"] }, { cells: ["three", "four"] }]));
    expect(rowsOf(out)).toEqual([["one", "two"], ["three", "four"]]);
  });

  it("keeps cells given as {values:[...]}", () => {
    expect(rowsOf(coerceRenderPdfInput(table([{ values: ["x", "y"] }])))).toEqual([["x", "y"]]);
  });

  it("falls back to an object's own values", () => {
    expect(rowsOf(coerceRenderPdfInput(table([{ source: "site", status: "ok" }])))).toEqual([["site", "ok"]]);
  });

  it("still accepts a plain array row, padded to the column count", () => {
    expect(rowsOf(coerceRenderPdfInput(table([["only"]])))).toEqual([["only", ""]]);
  });
});
