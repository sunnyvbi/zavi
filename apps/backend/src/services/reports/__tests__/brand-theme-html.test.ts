import { describe, expect, it } from "vitest";
import {
  blogThemeFromBrand,
  docThemeFromBrand,
  mixHex,
  contrastRatio,
  DEFAULT_BLOG_THEME,
  DEFAULT_DOC_THEME,
  MIN_TEXT_CONTRAST,
} from "../brand-theme";
import { renderBlogHtml } from "../render-html";
import { renderDocHtml } from "../render-doc-html";
import type { RenderDocInput } from "../doc-schema";

const PLATFORM_EMERALD = "#0E9F6E";
const PLATFORM_BLUE = "#027BFF";

const BLOG = {
  title: "How hosts get direct bookings",
  body: "## What it takes\n\nA paragraph.\n\n> A quote.\n",
  readTimeMinutes: 5,
};
const DOC: RenderDocInput = {
  title: "How refunds work",
  sections: [{ heading: "The flow", body_markdown: "A paragraph." }],
};

function paintedHexes(html: string): string[] {
  return (html.match(/#[0-9a-fA-F]{6}\b/g) ?? []).map((h) => h.toLowerCase());
}

describe("blogThemeFromBrand", () => {
  it("paints a legible brand primary into the emitted CSS, not our emerald", () => {
    const theme = blogThemeFromBrand({ primary: "#027bff", accent: null, source: "scrape" });
    const html = renderBlogHtml(BLOG, theme);
    expect(paintedHexes(html)).toContain("#027bff");
    expect(paintedHexes(html)).not.toContain(PLATFORM_EMERALD.toLowerCase());
  });

  it("keeps the brand hex out of the neutrals — only the accent moves", () => {
    const theme = blogThemeFromBrand({ primary: "#027bff", source: "scrape" });
    expect(theme.ink).toBe(DEFAULT_BLOG_THEME.ink);
    expect(theme.paper).toBe(DEFAULT_BLOG_THEME.paper);
    expect(theme.slate).toBe(DEFAULT_BLOG_THEME.slate);
  });

  it("falls back to the accent when the primary washes out on cream", () => {
    const theme = blogThemeFromBrand({ primary: "#f7f7f7", accent: "#8a1c1c", source: "scrape" });
    expect(theme.accent).toBe("#8a1c1c");
  });

  it("keeps the platform accent when NEITHER brand hex is legible on cream", () => {
    const theme = blogThemeFromBrand({ primary: "#fdfdfd", accent: "#fbfbfb", source: "scrape" });
    expect(theme.accent).toBe(DEFAULT_BLOG_THEME.accent);
  });

  it("a kit we could not read keeps the platform theme — never our blue as theirs", () => {
    const theme = blogThemeFromBrand({ primary: "#027bff", source: "default" });
    expect(theme).toEqual(DEFAULT_BLOG_THEME);
  });

  it("an absent kit renders exactly what the renderer rendered before", () => {
    expect(renderBlogHtml(BLOG, blogThemeFromBrand(null))).toBe(renderBlogHtml(BLOG));
  });
});

describe("a brand hex that colours WORDS takes the AA bar, not the rule bar", () => {
  const ORANGE = "#ff6b00";
  const SKY = "#4db8ff";

  it("keeps the brand rule but not the brand link when the hex fails AA", () => {
    const theme = blogThemeFromBrand({ primary: ORANGE, source: "scrape" });
    expect(theme.accent).toBe(ORANGE);
    expect(theme.accentText).not.toBe(ORANGE);
    expect(contrastRatio(theme.accentText, theme.paper)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
  });

  it("emits the readable colour into the stylesheet's link rule", () => {
    const html = renderBlogHtml(BLOG, blogThemeFromBrand({ primary: ORANGE, source: "scrape" }));
    const link = html.match(/a \{ color: (#[0-9a-fA-F]{6}); \}/)?.[1];
    expect(link?.toLowerCase()).not.toBe(ORANGE);
    expect(contrastRatio(link!, DEFAULT_BLOG_THEME.paper)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
  });

  it("uses the brand hex for links when it DOES pass AA", () => {
    const theme = blogThemeFromBrand({ primary: "#8a1c1c", source: "scrape" });
    expect(theme.accentText).toBe("#8a1c1c");
  });

  it("the doc refuses a pale brand hex for its 12px headings", () => {
    const theme = docThemeFromBrand({ primary: SKY, source: "scrape" });
    expect(theme.blueDark).toBe(SKY);
    expect(theme.blue).toBe(DEFAULT_DOC_THEME.blue);
  });

  it("contrastRatio matches the WCAG anchors", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
  });
});

describe("mixHex", () => {
  it("returns the foreground at ratio 1 and the background at ratio 0", () => {
    expect(mixHex("#027bff", "#ffffff", 1)).toBe("#027bff");
    expect(mixHex("#027bff", "#ffffff", 0)).toBe("#ffffff");
  });

  it("lands between the two at 0.5", () => {
    expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
  });

  it("returns the background rather than #NaNNaNNaN on garbage", () => {
    expect(mixHex("not-a-colour", "#ffffff", 0.5)).toBe("#ffffff");
    expect(mixHex("#027bff", "rgb(2,123,255)", 0.5)).toBe("#000000");
    expect(mixHex("#027bff", "#ffffff", Number.NaN)).toBe("#ffffff");
  });

  it("always emits a 6-digit hex", () => {
    expect(mixHex("#010203", "#000000", 0.08)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("docThemeFromBrand", () => {
  it("writes the brand accent into the emitted stylesheet and drops our blue", () => {
    const theme = docThemeFromBrand({ primary: "#d71505", accent: null, source: "scrape" });
    const html = renderDocHtml(DOC, undefined, theme);
    const painted = paintedHexes(html);
    expect(painted).toContain("#d71505");
    const light = [...html.matchAll(/:root\{--blue:(#[0-9a-fA-F]{6})/g)].pop();
    expect(light?.[1].toLowerCase()).toBe("#d71505");
    const dark = [...html.matchAll(/:root:not\(\[data-theme="light"\]\)\{--blue:(#[0-9a-fA-F]{6})/g)].pop();
    expect(dark?.[1].toLowerCase()).toBe(DEFAULT_DOC_THEME.blueDark.toLowerCase());
  });

  it("derives the soft and line tints from the brand hex, not from blue", () => {
    const theme = docThemeFromBrand({ primary: "#d71505", source: "scrape" });
    expect(theme.blueSoft).not.toBe(DEFAULT_DOC_THEME.blueSoft);
    expect(theme.blueLine).not.toBe(DEFAULT_DOC_THEME.blueLine);
    expect(theme.blueSoft).toBe(mixHex("#d71505", "#ffffff", 0.08));
  });

  it("keeps the platform dark trio when no brand hex reads on the dark ground", () => {
    const theme = docThemeFromBrand({ primary: "#10243b", accent: "#0b1a2b", source: "scrape" });
    expect(theme.blueDark).toBe(DEFAULT_DOC_THEME.blueDark);
    expect(theme.blueSoftDark).toBe(DEFAULT_DOC_THEME.blueSoftDark);
  });

  it("a bright brand hex DOES win the dark block — the override is not inert", () => {
    const theme = docThemeFromBrand({ primary: "#4db8ff", source: "scrape" });
    expect(theme.blueDark).toBe("#4db8ff");
    const html = renderDocHtml(DOC, undefined, theme);
    const dark = [...html.matchAll(/:root:not\(\[data-theme="light"\]\)\{--blue:(#[0-9a-fA-F]{6})/g)].pop();
    expect(dark?.[1].toLowerCase()).toBe("#4db8ff");
    expect(dark?.[1].toLowerCase()).not.toBe(DEFAULT_DOC_THEME.blueDark.toLowerCase());
  });

  it("a kit we could not read emits NO override block at all", () => {
    const theme = docThemeFromBrand({ primary: "#027bff", source: "default" });
    expect(theme).toEqual(DEFAULT_DOC_THEME);
    const html = renderDocHtml(DOC, undefined, theme);
    expect([...html.matchAll(/--blue:/g)]).toHaveLength(2);
    expect(html).toBe(renderDocHtml(DOC));
    expect(paintedHexes(html)).toContain(PLATFORM_BLUE.toLowerCase());
  });
});
