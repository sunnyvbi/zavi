
import { describe, it, expect } from "vitest";
import { sanitizeUrl, sanitizePatch, patchIsEmpty } from "../website-edits";

const URL_VECTORS: ReadonlyArray<{ input: string; href: string | null; src: string | null }> = [
  { input: "https://example.com/x", href: "https://example.com/x", src: "https://example.com/x" },
  { input: "http://example.com", href: "http://example.com", src: null },
  { input: "mailto:a@b.com", href: "mailto:a@b.com", src: null },
  { input: "tel:+15551234", href: "tel:+15551234", src: null },
  { input: "/rel/path", href: "/rel/path", src: "/rel/path" },
  { input: "./img.png", href: "./img.png", src: "./img.png" },
  { input: "#anchor", href: "#anchor", src: null },
  { input: "  https://trim.me/x  ", href: "https://trim.me/x", src: "https://trim.me/x" },
  { input: "HTTPS://UP.CASE/A", href: "HTTPS://UP.CASE/A", src: "HTTPS://UP.CASE/A" },
  {
    input: "https://my-hyphen-host.com/a-b",
    href: "https://my-hyphen-host.com/a-b",
    src: "https://my-hyphen-host.com/a-b",
  },
  { input: "javascript:alert(1)", href: null, src: null },
  { input: "JaVaScRiPt:alert(1)", href: null, src: null },
  { input: "data:text/html,x", href: null, src: null },
  { input: "vbscript:msgbox", href: null, src: null },
  { input: "file:///etc/passwd", href: null, src: null },
  { input: "//evil.com", href: null, src: null },
  { input: "\\\\evil.com", href: null, src: null },
  { input: "https://x.com/%00", href: null, src: null },
  { input: "java\tscript:alert(1)", href: null, src: null },
  { input: "https://x.com/a b", href: null, src: null },
  { input: "", href: null, src: null },
  { input: `https://x.com/${"a".repeat(3000)}`, href: null, src: null },
];

describe("backend sanitizeUrl — parity with the web validator", () => {
  for (const v of URL_VECTORS) {
    it(`href(${JSON.stringify(v.input).slice(0, 40)}) → ${v.href}`, () => {
      expect(sanitizeUrl("href", v.input)).toBe(v.href);
    });
    it(`src(${JSON.stringify(v.input).slice(0, 40)}) → ${v.src}`, () => {
      expect(sanitizeUrl("src", v.input)).toBe(v.src);
    });
  }
});

describe("backend sanitizePatch carries validated attrs (the storage gate)", () => {
  it("stores valid href/src, drops bad ones", () => {
    const out = sanitizePatch({ attrs: { href: "https://ok.com", src: "javascript:x" } });
    expect(out.attrs).toEqual({ href: "https://ok.com" });
  });
  it("drops attrs entirely when none survive (so the runtime never sees them)", () => {
    expect(sanitizePatch({ attrs: { href: "data:x", src: "mailto:a@b.com" } }).attrs).toBeUndefined();
  });
  it("still handles text/style alongside attrs", () => {
    const out = sanitizePatch({
      text: "hi",
      style: { color: "#111" },
      attrs: { href: "/go" },
    });
    expect(out).toEqual({ text: "hi", style: { color: "#111" }, attrs: { href: "/go" } });
  });
});

describe("patchIsEmpty — the write-route empty_patch guard", () => {
  it("an attrs-ONLY patch is NOT empty (a link/image edit must persist)", () => {
    expect(patchIsEmpty({ attrs: { href: "https://x.com" } })).toBe(false);
    expect(patchIsEmpty({ attrs: { src: "/img.png" } })).toBe(false);
  });
  it("text-only / style-only patches are not empty", () => {
    expect(patchIsEmpty({ text: "hi" })).toBe(false);
    expect(patchIsEmpty({ style: { color: "#000" } })).toBe(false);
  });
  it("a truly empty patch is empty", () => {
    expect(patchIsEmpty({})).toBe(true);
  });
});
