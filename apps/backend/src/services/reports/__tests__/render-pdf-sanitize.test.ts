
import { describe, it, expect } from "vitest";
import zlib from "node:zlib";
import { renderPdf } from "../render-pdf";

function extractStreams(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes);
  let raw = "";
  let idx = 0;
  for (;;) {
    const s = buf.indexOf("stream", idx);
    if (s === -1) break;
    const e = buf.indexOf("endstream", s);
    if (e === -1) break;
    let start = s + 6;
    if (buf[start] === 0x0d) start++;
    if (buf[start] === 0x0a) start++;
    const chunk = buf.subarray(start, e);
    try {
      raw += zlib.inflateSync(chunk).toString("latin1");
    } catch {
      raw += chunk.toString("latin1");
    }
    idx = e + 9;
  }
  const lines: string[] = [];
  const tj = /\[((?:\s*<[0-9a-fA-F\s]*>|\s*-?[\d.]+)*)\s*\]\s*TJ/g;
  let m: RegExpExecArray | null;
  while ((m = tj.exec(raw)) !== null) {
    let run = "";
    const piece = /<([0-9a-fA-F\s]*)>/g;
    let p: RegExpExecArray | null;
    while ((p = piece.exec(m[1])) !== null) {
      const clean = p[1].replace(/\s+/g, "");
      if (clean.length % 2 === 0 && clean.length > 0) {
        run += Buffer.from(clean, "hex").toString("latin1");
      }
    }
    lines.push(run);
  }
  const tjSimple = /\(((?:[^()\\]|\\.)*)\)\s*Tj/g;
  while ((m = tjSimple.exec(raw)) !== null) lines.push(m[1]);
  return lines.join("\n");
}

const base = {
  filename: "sanitize-e2e.pdf",
  title: "Evidence Packet",
  sections: [{ heading: "Case summary", body_markdown: "body" }],
};

describe("renderPdf applies the sanitizer (wiring)", () => {
  it("removes unrenderable glyphs from a prose body", async () => {
    const bytes = await renderPdf({
      ...base,
      sections: [
        {
          heading: "Gate analysis",
          body_markdown:
            "Gate 1 (≥2 prior charges): FAIL. Jun 13 → Jun 26. ✓ verified.",
        },
      ],
    });
    const text = extractStreams(bytes);

    expect(text).not.toContain("≥");
    expect(text).not.toContain("→");
    expect(text).not.toContain("✓");
    expect(text).toContain(">=2 prior charges");
    expect(text).toContain("Jun 13 -> Jun 26");
    expect(text).toContain("[x] verified");
  });

  it("sanitizes the title, heading, footer and table cells too", async () => {
    const bytes = await renderPdf({
      ...base,
      title: "Report → Q3",
      footer: "Generated ✓",
      sections: [
        {
          heading: "Metrics ≥ target",
          body_markdown: "ok",
          table: {
            columns: ["Metric", "Value ≥"],
            rows: [["uptime", "99.9 → 99.99"]],
          },
        },
      ],
    });
    const text = extractStreams(bytes);
    for (const bad of ["→", "✓", "≥"]) {
      expect(text).not.toContain(bad);
    }
    expect(text).toContain("Report -> Q3");
    expect(text).toContain("Metrics >= target");
  });

  it("repairs the preformatted/wireframe path and keeps the grid aligned", async () => {
    const art = ["┌──────┐", "│ box  │", "└──────┘"].join("\n");
    const bytes = await renderPdf({
      ...base,
      sections: [
        { heading: "Wireframe", body_markdown: "diagram", preformatted: art },
      ],
    });
    const text = extractStreams(bytes);

    expect(text).not.toContain("┌");
    expect(text).not.toContain("─");
    expect(text).not.toContain("│");
    expect(text).toContain("+------+");
    expect(text).toContain("| box  |");

    for (const line of art.split("\n")) {
      const converted = line
        .replace(/[┌┐└┘├┤┬┴┼]/g, "+")
        .replace(/─/g, "-")
        .replace(/│/g, "|");
      expect(converted.length).toBe(line.length);
      expect(text).toContain(converted);
    }
  });

  it("leaves natively-renderable characters untouched end-to-end", async () => {
    const bytes = await renderPdf({
      ...base,
      sections: [
        {
          heading: "Card",
          body_markdown: "Visa debit •••5429 — café “quoted” …done",
        },
      ],
    });
    const text = extractStreams(bytes);
    expect(text).toContain("\x95\x95\x955429");
    expect(text).not.toContain("   5429");
  });
});
