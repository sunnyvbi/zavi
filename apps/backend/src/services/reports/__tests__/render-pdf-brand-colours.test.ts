import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { renderPdf } from "../render-pdf";
import type { RenderPdfInput } from "../schema";
import { DEFAULT_REPORT_THEME, reportThemeFromBrand } from "../brand-theme";

const PLATFORM_GOLD = "#FFC93D";

const INPUT: RenderPdfInput = {
  title: "Signup funnel review",
  filename: "signup-funnel-review.pdf",
  sections: [
    { heading: "What we found", body_markdown: "- One bullet\n- Another bullet" },
    { heading: "What to do", body_markdown: "Plain paragraph." },
  ],
};

function paintedColours(bytes: Uint8Array): string[] {
  const buf = Buffer.from(bytes);
  const out = new Set<string>();
  let i = 0;
  for (;;) {
    const start = buf.indexOf("stream", i);
    if (start < 0) break;
    const end = buf.indexOf("endstream", start);
    if (end < 0) break;
    let body = buf.subarray(start + "stream".length, end);
    while (body.length && (body[0] === 0x0d || body[0] === 0x0a)) body = body.subarray(1);
    let text: string;
    try {
      text = zlib.inflateSync(body).toString("latin1");
    } catch {
      text = body.toString("latin1");
    }
    for (const m of text.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) (?:scn|SCN|sc|SC|rg|RG)\b/g)) {
      out.add(`${m[1]} ${m[2]} ${m[3]}`);
    }
    for (const m of text.matchAll(/(?:^|[^\d.])([\d.]+) [gG](?![A-Za-z])/g)) {
      out.add(`${m[1]} ${m[1]} ${m[1]}`);
    }
    i = end + "endstream".length;
  }
  return [...out];
}

function painted(list: string[], hex: string): boolean {
  const want = [1, 3, 5].map((o) => parseInt(hex.slice(o, o + 2), 16) / 255);
  return list.some((p) => {
    const got = p.split(" ").map(Number);
    return got.every((v, i) => Math.abs(v - want[i]) < 0.004);
  });
}

describe("report PDF paints the tenant's brand, not ours", () => {
  it("still paints the platform gold when no theme is passed", async () => {
    const list = paintedColours(await renderPdf(INPUT));
    expect(painted(list, PLATFORM_GOLD)).toBe(true);
  });

  it("paints both brand hexes and NO gold once a real kit is resolved", async () => {
    const theme = reportThemeFromBrand({
      primary: "#cbd5e0",
      accent: "#233d63",
      source: "scrape",
    });
    const list = paintedColours(await renderPdf(INPUT, undefined, undefined, theme));
    expect(painted(list, "#cbd5e0")).toBe(true);
    expect(painted(list, "#233d63")).toBe(true);
    expect(painted(list, PLATFORM_GOLD)).toBe(false);
  });

  it("keeps painting ink for body text, so only the accents move", async () => {
    const theme = reportThemeFromBrand({ primary: "#027bff", source: "manual" });
    const list = paintedColours(await renderPdf(INPUT, undefined, undefined, theme));
    expect(painted(list, DEFAULT_REPORT_THEME.ink)).toBe(true);
    expect(painted(list, "#027bff")).toBe(true);
    expect(painted(list, PLATFORM_GOLD)).toBe(false);
  });
});
