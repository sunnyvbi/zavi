
import { describe, it, expect } from "vitest";
import PDFDocument from "pdfkit";
import {
  safePdfProseText,
  safePdfMonoText,
  takePdfSanitizeDropCount,
  sanitizeRenderPdfInput,
} from "../sanitize-pdf-text";

function maxGlyphCode(doc: PDFKit.PDFDocument, ch: string): number {
  const [codes] = (doc as unknown as {
    _font: { encode(s: string): [string[], unknown[]] };
  })._font.encode(ch);
  return Math.max(...codes.map((c) => parseInt(c, 16)));
}

const RENDERS_FINE = [
  ["bullet", "•"],
  ["em dash", "—"],
  ["en dash", "–"],
  ["left single quote", "‘"],
  ["right single quote", "’"],
  ["left double quote", "“"],
  ["right double quote", "”"],
  ["ellipsis", "…"],
  ["euro", "€"],
  ["multiplication sign", "×"],
  ["e acute", "é"],
  ["trademark", "™"],
] as const;

const MANGLES = [
  ["greater-or-equal", "≥"],
  ["less-or-equal", "≤"],
  ["rightwards arrow", "→"],
  ["leftwards arrow", "←"],
  ["check mark", "✓"],
  ["minus sign", "−"],
  ["box light down-right", "┌"],
  ["box light horizontal", "─"],
  ["box light vertical", "│"],
  ["box light up-left", "┘"],
  ["black down triangle", "▼"],
  ["emoji", "\u{1F4CA}"],
] as const;

describe("encoder ground truth (pdfkit standard-14)", () => {
  it.each(RENDERS_FINE)(
    "%s renders natively and must NOT be substituted",
    (_name, ch) => {
      const doc = new PDFDocument();
      doc.font("Helvetica");
      expect(maxGlyphCode(doc, ch)).toBeLessThanOrEqual(0xff);
      expect(safePdfProseText(ch)).toBe(ch);
    },
  );

  it.each(MANGLES)("%s does NOT render and must be substituted", (_name, ch) => {
    const doc = new PDFDocument();
    doc.font("Helvetica");
    expect(maxGlyphCode(doc, ch)).toBeGreaterThan(0xff);
    expect(safePdfProseText(ch)).not.toBe(ch);
  });

  it("box-drawing mangles in Courier too (the preformatted path's font)", () => {
    const doc = new PDFDocument();
    doc.font("Courier");
    for (const ch of ["┌", "─", "│", "┘"]) {
      expect(maxGlyphCode(doc, ch)).toBeGreaterThan(0xff);
    }
  });
});

describe("safePdfProseText", () => {
  it("maps comparison and arrow operators to ASCII", () => {
    expect(safePdfProseText("a ≥ 2")).toBe("a >= 2");
    expect(safePdfProseText("a ≤ 2")).toBe("a <= 2");
    expect(safePdfProseText("Jun 13 → Jun 26")).toBe("Jun 13 -> Jun 26");
    expect(safePdfProseText("✓ done")).toBe("[x] done");
  });

  it("reproduces the 2026-07-18 defect inputs without mojibake", () => {
    expect(safePdfProseText("Disputes → du_1Totr8")).toBe(
      "Disputes -> du_1Totr8",
    );
    expect(safePdfProseText("Gate 1 (≥2 prior charges)")).toBe(
      "Gate 1 (>=2 prior charges)",
    );
    expect(safePdfProseText("\u{1F6A8} DEADLINE")).toBe("  DEADLINE");
    expect(safePdfProseText("a✗b")).toBe("a[ ]b");
  });

  it("passes renderable characters through UNCHANGED (anti-regression)", () => {
    const line = "•••5429 — café “quoted”…";
    expect(safePdfProseText(line)).toBe(line);
  });

  it("handles empty and plain-ASCII input as identity", () => {
    expect(safePdfProseText("")).toBe("");
    expect(safePdfProseText("plain ascii 123")).toBe("plain ascii 123");
  });
});

describe("safePdfMonoText", () => {
  it("PRESERVES code-point length exactly (the grid invariant)", () => {
    const art = [
      "┌────┐",
      "│ hi │",
      "└────┘",
      "   ▼",
    ];
    for (const line of art) {
      const out = safePdfMonoText(line);
      expect([...out].length).toBe([...line].length);
    }
  });

  it("converts box-art to aligned ASCII", () => {
    expect(safePdfMonoText("┌──┐")).toBe("+--+");
    expect(safePdfMonoText("│ x │")).toBe("| x |");
    expect(safePdfMonoText("└─┘")).toBe("+-+");
    expect(safePdfMonoText("▼")).toBe("v");
  });

  it("never expands, even for operators prose would widen", () => {
    expect(safePdfMonoText("≥")).toHaveLength(1);
    expect(safePdfMonoText("≤")).toHaveLength(1);
    expect(safePdfMonoText("→")).toHaveLength(1);
    expect(safePdfProseText("≥")).toHaveLength(2);
  });

  it("preserves length for unmapped astral characters", () => {
    const s = "a\u{1F4CA}b";
    expect([...safePdfMonoText(s)].length).toBe([...s].length);
  });

  it("leaves renderable characters alone", () => {
    expect(safePdfMonoText("plain — text")).toBe("plain — text");
  });
});

describe("undefined WinAnsi slots (in-range but .notdef)", () => {
  it.each([0x7f, 0x81, 0x8d, 0x8f, 0x90, 0x9d])(
    "substitutes undefined slot 0x%s",
    (cp) => {
      const ch = String.fromCharCode(cp as number);
      expect(safePdfProseText(ch)).toBe(" ");
    },
  );

  it("counts them as drops rather than losing them silently", () => {
    takePdfSanitizeDropCount();
    safePdfProseText(`a${String.fromCharCode(0x8d)}b`);
    expect(takePdfSanitizeDropCount()).toBe(1);
  });

  it("still passes DEFINED high-byte characters through", () => {
    expect(safePdfProseText("\x95\x97")).toBe("\x95\x97");
  });
});

describe("re-clipping after expansion (post-zod budget guard)", () => {
  it("clips a body that expansion pushed past the 10k cap", () => {
    const input = {
      title: "t",
      filename: "f.pdf",
      sections: [{ heading: "h", body_markdown: "✓".repeat(4000) }],
    };
    const out = sanitizeRenderPdfInput(input);
    expect(out.sections[0].body_markdown.length).toBeLessThanOrEqual(10_000);
  });

  it("clips title, heading, footer and table cells to their caps", () => {
    const out = sanitizeRenderPdfInput({
      title: "✓".repeat(150),
      footer: "✓".repeat(300),
      filename: "f.pdf",
      sections: [
        {
          heading: "✓".repeat(150),
          body_markdown: "ok",
          table: {
            columns: ["✓".repeat(300)],
            rows: [["✓".repeat(300)]],
          },
        },
      ],
    });
    expect(out.title.length).toBeLessThanOrEqual(200);
    expect(out.footer!.length).toBeLessThanOrEqual(500);
    expect(out.sections[0].heading.length).toBeLessThanOrEqual(200);
    expect(out.sections[0].table!.columns[0].length).toBeLessThanOrEqual(500);
    expect(out.sections[0].table!.rows[0][0].length).toBeLessThanOrEqual(500);
  });

  it("does not clip content that did not grow", () => {
    const body = "plain prose ".repeat(100);
    const out = sanitizeRenderPdfInput({
      title: "t",
      filename: "f.pdf",
      sections: [{ heading: "h", body_markdown: body }],
    });
    expect(out.sections[0].body_markdown).toBe(body);
  });

  it("leaves preformatted unclipped — mono is length-preserving by construction", () => {
    const art = "┌───┐\n│ x │\n└───┘";
    const out = sanitizeRenderPdfInput({
      title: "t",
      filename: "f.pdf",
      sections: [{ heading: "h", body_markdown: "b", preformatted: art }],
    });
    expect(out.sections[0].preformatted!.length).toBe(art.length);
  });
});

describe("drop-count metric", () => {
  it("counts substitutions and resets on read", () => {
    takePdfSanitizeDropCount();
    safePdfProseText("≥ → ✓");
    expect(takePdfSanitizeDropCount()).toBe(3);
    expect(takePdfSanitizeDropCount()).toBe(0);
  });

  it("does not count characters that passed through", () => {
    takePdfSanitizeDropCount();
    safePdfProseText("• bullet — dash");
    expect(takePdfSanitizeDropCount()).toBe(0);
  });
});
