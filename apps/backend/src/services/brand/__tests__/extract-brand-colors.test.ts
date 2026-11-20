import { describe, it, expect } from "vitest";
import {
  extractBrandColors,
  isAccentCandidate,
  isBrandCandidate,
  normalizeHex,
  rgbToHex,
  lightness,
} from "../extract-brand-colors";

describe("normalizeHex / rgbToHex", () => {
  it("expands shorthand and lowercases", () => {
    expect(normalizeHex("#ABC")).toBe("#aabbcc");
    expect(normalizeHex("027BFF")).toBe("#027bff");
  });
  it("drops alpha rather than failing", () => {
    expect(normalizeHex("#027bff80")).toBe("#027bff");
  });
  it("rejects junk", () => {
    expect(normalizeHex("#xyz")).toBeNull();
    expect(normalizeHex("blue")).toBeNull();
  });
  it("parses legacy and modern rgb syntax", () => {
    expect(rgbToHex("rgb(2, 123, 255)")).toBe("#027bff");
    expect(rgbToHex("rgba(2 123 255 / 50%)")).toBe("#027bff");
  });
});

describe("isBrandCandidate", () => {
  it("rejects the greys that dominate every real stylesheet", () => {
    expect(isBrandCandidate("#e5e7eb")).toBe(false);
    expect(isBrandCandidate("#ffffff")).toBe(false);
    expect(isBrandCandidate("#000000")).toBe(false);
    expect(isBrandCandidate("#6b7280")).toBe(false);
  });
  it("accepts a saturated brand hue", () => {
    expect(isBrandCandidate("#027bff")).toBe(true);
    expect(isBrandCandidate("#ff5a1f")).toBe(true);
  });
});

describe("extractBrandColors", () => {
  it("theme-color outranks a more frequent grey", () => {
    const out = extractBrandColors({
      html: '<meta name="theme-color" content="#027BFF">',
      css: [".a{color:#e5e7eb}.b{color:#e5e7eb}.c{color:#e5e7eb}"],
    });
    expect(out.primary).toBe("#027bff");
  });

  it("reads a css custom property named for the brand", () => {
    const out = extractBrandColors({
      html: "",
      css: [":root{--color-primary:#027bff;--accent:#ff5a1f;--primary-foreground:#ffffff}"],
    });
    expect(out.primary).toBe("#027bff");
    expect(out.accent).toBe("#ff5a1f");
  });

  it("ignores a *-foreground var (that is text ON the brand, not the brand)", () => {
    const out = extractBrandColors({
      html: "",
      css: [":root{--primary-foreground:#22c55e}"],
    });
    expect(out.primary).toBeNull();
  });

  it("falls back to the primary-button background when no vars exist", () => {
    const out = extractBrandColors({
      html: "",
      css: [".btn-primary{background-color:rgb(2,123,255);border:1px solid #e5e7eb}"],
    });
    expect(out.primary).toBe("#027bff");
  });

  it("picks up an inlined tailwind config token", () => {
    const out = extractBrandColors({
      html: `<script>tailwind.config={theme:{colors:{primary:"#027bff"}}}</script>`,
      css: [],
    });
    expect(out.primary).toBe("#027bff");
  });

  it("accent never duplicates primary", () => {
    const out = extractBrandColors({
      html: '<meta name="theme-color" content="#027bff">',
      css: [":root{--accent:#027bff}"],
    });
    expect(out.primary).toBe("#027bff");
    expect(out.accent).not.toBe("#027bff");
  });

  it("returns nulls instead of inventing a hex when the page has no colour at all", () => {
    const out = extractBrandColors({ html: "<html><body>hi</body></html>", css: [] });
    expect(out.primary).toBeNull();
    expect(out.accent).toBeNull();
    expect(out.evidence).toEqual([]);
  });

  it("names a light bg and a dark text out of frequency", () => {
    const out = extractBrandColors({
      html: "",
      css: ["body{background:#ffffff;color:#191919}.x{background:#ffffff}.y{color:#191919}"],
    });
    expect(out.bg).toBe("#ffffff");
    expect(out.text).toBe("#191919");
    expect(lightness(out.bg!)).toBeGreaterThan(0.9);
  });

  it("keeps auditable evidence for the chosen hex and drops the frequency noise", () => {
    const out = extractBrandColors({
      html: '<meta name="theme-color" content="#027bff">',
      css: [":root{--color-primary:#027bff}", ".a{color:#e5e7eb}"],
    });
    expect(out.evidence.length).toBeGreaterThan(0);
    expect(out.evidence.every((e) => e.signal !== "frequency")).toBe(true);
    expect(out.evidence[0].signal).toBe("meta_theme_color");
    expect(out.evidence.some((e) => e.hex === "#e5e7eb")).toBe(false);
  });

  it("reads <style> blocks in the html as stylesheet source", () => {
    const out = extractBrandColors({
      html: "<style>:root{--brand:#7c3aed}</style>",
      css: [],
    });
    expect(out.primary).toBe("#7c3aed");
  });
});

describe("isAccentCandidate", () => {
  it("rejects a cream that cleared the brand-candidate bar (zaviagent.com)", () => {
    expect(isBrandCandidate("#ece8e0")).toBe(true);
    expect(isAccentCandidate("#ece8e0")).toBe(false);
  });
  it("rejects a near-black navy (upcar.ai)", () => {
    expect(isAccentCandidate("#101828")).toBe(false);
  });
  it("accepts a real accent", () => {
    expect(isAccentCandidate("#ff5a1f")).toBe(true);
    expect(isAccentCandidate("#0e9f6e")).toBe(true);
  });
});

describe("accent slot end to end", () => {
  it("returns null rather than a cream — primary is a safer fallback than a wrong hex", () => {
    const out = extractBrandColors({
      html: '<meta name="theme-color" content="#027bff">',
      css: [":root{--accent:#ece8e0}"],
    });
    expect(out.primary).toBe("#027bff");
    expect(out.accent).toBeNull();
  });
  it("keeps an accent that can actually carry a pill", () => {
    const out = extractBrandColors({
      html: '<meta name="theme-color" content="#027bff">',
      css: [":root{--accent:#ff5a1f}"],
    });
    expect(out.accent).toBe("#ff5a1f");
  });
});
