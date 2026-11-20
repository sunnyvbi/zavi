
import { describe, it, expect } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import sharp from "sharp";
import { buildLogoSvg } from "../build-logo-svg";
import { logoSpecSchema, renderPdfInputSchema, MAX_LOGO_SPEC_PER_CALL } from "../schema";

const DANGEROUS = [
  "<script",
  "<foreignObject",
  "href",
  "xlink",
  "url(",
  "<!doctype",
  "<!entity",
  "javascript:",
  "<use",
  "<image",
];

function assertNoDangerousConstructs(svg: string) {
  const lower = svg.toLowerCase();
  for (const bad of DANGEROUS) {
    expect(lower.includes(bad), `built SVG must not contain "${bad}": ${svg}`).toBe(false);
  }
}

describe("buildLogoSvg — happy path", () => {
  it("builds a well-formed, self-contained SVG from a valid spec", () => {
    const spec = logoSpecSchema.parse({
      viewBox: "0 0 64 64",
      background: "#ffffff",
      elements: [
        { type: "circle", cx: 32, cy: 32, r: 20, fill: "#123456" },
        { type: "text", content: "PR", x: 32, y: 40, font_family: "sans", font_size: 18, fill: "navy", text_anchor: "middle" },
      ],
    });
    const svg = buildLogoSvg(spec);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.includes('xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg.includes("<circle")).toBe(true);
    expect(svg.includes(">PR</text>")).toBe(true);
    assertNoDangerousConstructs(svg);
  });

  it("real sharp rasterizes the built SVG to a non-empty PNG", async () => {
    const spec = logoSpecSchema.parse({ elements: [{ type: "rect", x: 4, y: 4, width: 56, height: 56, rx: 8, fill: "#0a2540" }] });
    const png = await sharp(Buffer.from(buildLogoSvg(spec)), { unlimited: false }).png().toBuffer();
    expect(png.byteLength).toBeGreaterThan(0);
    expect(png.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
});

describe("logoSpecSchema — rejects adversarial FIELD values (the security boundary)", () => {
  const REJECTED: Array<[string, unknown]> = [
    ["path d with markup", { elements: [{ type: "path", d: "</path><script>alert(1)</script>" }] }],
    ["fill = url()", { elements: [{ type: "circle", cx: 1, cy: 1, r: 1, fill: "url(http://evil)" }] }],
    ["fill = javascript scheme", { elements: [{ type: "rect", x: 0, y: 0, width: 1, height: 1, fill: "javascript:alert(1)" }] }],
    ["non-enum font_family", { elements: [{ type: "text", content: "x", x: 0, y: 0, font_family: "'>\"<script>", font_size: 10 }] }],
    ["too many elements", { elements: Array.from({ length: 41 }, () => ({ type: "circle", cx: 1, cy: 1, r: 1 })) }],
    ["out-of-range coordinate", { elements: [{ type: "circle", cx: 999999, cy: 1, r: 1 }] }],
    ["non-finite number", { elements: [{ type: "circle", cx: Infinity, cy: 1, r: 1 }] }],
    ["viewBox over 512", { viewBox: "0 0 9999 9999", elements: [{ type: "circle", cx: 1, cy: 1, r: 1 }] }],
    ["points with markup", { elements: [{ type: "polygon", points: "0,0 <script>" }] }],
    ["empty elements", { elements: [] }],
    ["oversized path d", { elements: [{ type: "path", d: "M0 0 " + "L1 1 ".repeat(1000) }] }],
  ];

  for (const [name, spec] of REJECTED) {
    it(`rejects: ${name}`, () => {
      expect(logoSpecSchema.safeParse(spec).success).toBe(false);
    });
  }
});

describe("buildLogoSvg — anything that VALIDATES builds to safe output", () => {
  it("text content that looks like markup is XML-ESCAPED, never emitted raw", () => {
    const spec = logoSpecSchema.parse({
      elements: [{ type: "text", content: "<script>alert(1)</script>", x: 0, y: 10, font_family: "mono", font_size: 8 }],
    });
    const svg = buildLogoSvg(spec);
    assertNoDangerousConstructs(svg);
    expect(svg.includes("&lt;script&gt;")).toBe(true);
  });

  it("an ampersand in text becomes &amp; (well-formed XML)", () => {
    const spec = logoSpecSchema.parse({ elements: [{ type: "text", content: "A & B", x: 0, y: 10, font_family: "serif", font_size: 8 }] });
    const svg = buildLogoSvg(spec);
    expect(svg.includes("A &amp; B")).toBe(true);
    return sharp(Buffer.from(svg), { unlimited: false }).png().toBuffer().then((b) => expect(b.byteLength).toBeGreaterThan(0));
  });
});

describe("per-call cap — bounds the model turn so a huge logo set can't run away", () => {
  const logoSection = (i: number) => ({
    heading: `Logo ${i}`,
    body_markdown: "x",
    logo_spec: { elements: [{ type: "circle", cx: 1, cy: 1, r: 1, fill: "#000" }] },
  });
  const input = (n: number) => ({
    title: "Logos",
    filename: "logos.pdf",
    sections: Array.from({ length: n }, (_, i) => logoSection(i + 1)),
  });

  it(`accepts up to ${MAX_LOGO_SPEC_PER_CALL} logo_spec sections`, () => {
    expect(renderPdfInputSchema.safeParse(input(MAX_LOGO_SPEC_PER_CALL)).success).toBe(true);
  });

  it(`REJECTS >${MAX_LOGO_SPEC_PER_CALL} with an instructive message (falsifier for the 27-min reap)`, () => {
    const res = renderPdfInputSchema.safeParse(input(MAX_LOGO_SPEC_PER_CALL + 1));
    expect(res.success).toBe(false);
    if (!res.success) {
      const msg = res.error.issues.map((i) => i.message).join(" ");
      expect(msg).toMatch(/too many logo_spec/i);
      expect(msg).toMatch(/strong|distinct|more|variations|follow-up/i);
    }
  });

  it("20 logos in one call is rejected (the original incident) — instantly, not after 27min", () => {
    expect(renderPdfInputSchema.safeParse(input(20)).success).toBe(false);
  });

  it("mixing logos with non-logo sections only counts the logo ones", () => {
    const mixed = {
      title: "Mixed",
      filename: "m.pdf",
      sections: [
        ...Array.from({ length: MAX_LOGO_SPEC_PER_CALL }, (_, i) => logoSection(i + 1)),
        { heading: "Prose", body_markdown: "just text, no logo" },
      ],
    };
    expect(renderPdfInputSchema.safeParse(mixed).success).toBe(true);
  });
});

describe("render-layer boundary — sharp/librsvg makes NO external request", () => {
  it("a hand-crafted hostile SVG with an external <image href> triggers ZERO network request", async () => {
    let hits = 0;
    const server = http.createServer((_req, res) => {
      hits++;
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const hostile =
        `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="64" height="64">` +
        `<image xlink:href="http://127.0.0.1:${port}/pixel.png" width="64" height="64"/>` +
        `<image href="http://127.0.0.1:${port}/pixel2.png" width="64" height="64"/></svg>`;
      try {
        await sharp(Buffer.from(hostile), { unlimited: false }).png().toBuffer();
      } catch {
      }
      await new Promise((r) => setTimeout(r, 200));
      expect(hits).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
