import { describe, expect, it } from "vitest";
import {
  DEFAULT_DECK_THEME,
  DEFAULT_REPORT_THEME,
  deckThemeFromBrand,
  pickLegible,
  reportThemeFromBrand,
} from "../brand-theme";

const UPCAR = { primary: "#cbd5e0", accent: "#233d63", source: "scrape" as const };

describe("pickLegible", () => {
  it("skips a hex too dark for a dark surface and takes the next", () => {
    expect(pickLegible(["#233d63", "#cbd5e0"], "dark")).toBe("#cbd5e0");
  });

  it("skips a hex too pale for a light surface and takes the next", () => {
    expect(pickLegible(["#cbd5e0", "#233d63"], "light")).toBe("#233d63");
  });

  it("returns null when nothing is legible, so the caller can fall back", () => {
    expect(pickLegible(["#111111", "#0a0a0a"], "dark")).toBeNull();
  });

  it("ignores blanks and unparseable values rather than painting with them", () => {
    expect(pickLegible([null, undefined, "not-a-hex", "#cbd5e0"], "dark")).toBe("#cbd5e0");
  });

  it("normalizes shorthand so #fff and #ffffff behave the same", () => {
    expect(pickLegible(["#fff"], "dark")).toBe("#ffffff");
  });
});

describe("reportThemeFromBrand", () => {
  it("paints each surface with whichever brand hex reads on it", () => {
    const t = reportThemeFromBrand(UPCAR);
    expect(t.bandRule).toBe("#cbd5e0");
    expect(t.accentRule).toBe("#233d63");
  });

  it("no longer paints the platform marigold for a real kit", () => {
    const t = reportThemeFromBrand(UPCAR);
    expect(t.bandRule).not.toBe("#FFC93D");
    expect(t.accentRule).not.toBe("#FFC93D");
  });

  it("keeps the neutrals structural, never brand-derived", () => {
    const t = reportThemeFromBrand(UPCAR);
    expect(t.ink).toBe(DEFAULT_REPORT_THEME.ink);
    expect(t.paper).toBe(DEFAULT_REPORT_THEME.paper);
    expect(t.mist).toBe(DEFAULT_REPORT_THEME.mist);
  });

  it("keeps the platform theme when the kit is our default", () => {
    expect(reportThemeFromBrand({ primary: "#027bff", source: "default" })).toEqual(
      DEFAULT_REPORT_THEME,
    );
    expect(reportThemeFromBrand(null)).toEqual(DEFAULT_REPORT_THEME);
  });

  it("falls back per surface when a brand hex cannot be read there", () => {
    const t = reportThemeFromBrand({ primary: "#111111", accent: "#0a0a0a", source: "scrape" });
    expect(t.bandRule).toBe(DEFAULT_REPORT_THEME.bandRule);
    expect(t.accentRule).toBe("#111111");
  });

  it("works from a primary alone, with no accent on file", () => {
    const t = reportThemeFromBrand({ primary: "#027bff", accent: null, source: "manual" });
    expect(t.bandRule).toBe("#027bff");
    expect(t.accentRule).toBe("#027bff");
  });
});

describe("deckThemeFromBrand", () => {
  it("picks both tokens for the cream slide, preferring a different hex each", () => {
    const t = deckThemeFromBrand(UPCAR);
    expect(t.accent).toBe("#233d63");
    expect(t.gold).toBe("#233d63");
    expect(t.cream).toBe(DEFAULT_DECK_THEME.cream);
  });

  it("keeps the platform theme for a default kit", () => {
    expect(deckThemeFromBrand({ source: "default" })).toEqual(DEFAULT_DECK_THEME);
  });
});
