import { describe, it, expect } from "vitest";
import {
  DEFAULT_THEME_PRESET,
  FONT_LIBRARY,
  OVERLAY_DARK,
  THEME_CSS_PATH,
  THEME_PRESETS,
  contrastRatio,
  describeThemePresets,
  getThemePreset,
  renderThemeCss,
  resolveTheme,
  validateThemePreset,
  type ThemePreset,
} from "../theme-presets";

const AA = 4.5;

function pairs(p: ThemePreset): Array<[string, string, string, number]> {
  const t = resolveTheme(p);
  const i = t.inverse;
  return [
    ["foreground on background", t.foreground, t.background, 7],
    ["foreground on muted", t.foreground, t.muted, AA],
    ["card-foreground on card", t.cardForeground, t.card, AA],
    ["muted-foreground on background", t.mutedForeground, t.background, AA],
    ["muted-foreground on muted", t.mutedForeground, t.muted, AA],
    ["muted-foreground on card", t.mutedForeground, t.card, AA],
    ["primary-foreground on primary", t.primaryForeground, t.primary, AA],
    ["primary (links, eyebrows) on background", t.primary, t.background, AA],
    ["primary (eyebrows) on muted", t.primary, t.muted, AA],
    ["secondary-foreground on secondary", t.secondaryForeground, t.secondary, AA],
    ["accent-foreground on accent", t.accentForeground, t.accent, AA],
    ["danger on background", t.danger, t.background, AA],
    ["danger-foreground on danger", t.dangerForeground, t.danger, AA],
    ["danger on card", t.danger, t.card, AA],
    ["success (icons) on card", t.success, t.card, 3],
    ["inverse: foreground", i.foreground, i.background, 7],
    ["inverse: muted-foreground", i.mutedForeground, i.background, AA],
    ["inverse: muted-foreground on muted", i.mutedForeground, i.muted, AA],
    ["inverse: foreground on card", i.foreground, i.card, AA],
    ["inverse: primary-foreground on primary", i.primaryForeground, i.primary, AA],
    ["inverse: primary as text", i.primary, i.background, AA],
    ["inverse: danger on background", i.danger, i.background, AA],
    ["inverse: danger on card", i.danger, i.card, AA],
    ["inverse: danger-foreground on danger", i.dangerForeground, i.danger, AA],
    ["inverse: success (icons) on card", i.success, i.card, 3],
    ["overlay: primary-foreground on primary", t.overlay.primaryForeground, t.overlay.primary, AA],
    ["overlay: primary button against the scrim", t.overlay.primary, OVERLAY_DARK, 3],
  ];
}

describe("theme presets: the catalogue", () => {
  it("has 6-10 presets with unique names and a default that exists", () => {
    expect(THEME_PRESETS.length).toBeGreaterThanOrEqual(6);
    expect(THEME_PRESETS.length).toBeLessThanOrEqual(16);
    expect(new Set(THEME_PRESETS.map((p) => p.name)).size).toBe(THEME_PRESETS.length);
    expect(new Set(THEME_PRESETS.map((p) => p.mood)).size).toBe(THEME_PRESETS.length);
    expect(getThemePreset(DEFAULT_THEME_PRESET)).toBeDefined();
    expect(THEME_CSS_PATH).toBe("src/theme.css");
  });

  it("covers light and dark grounds, serif and sans display fonts", () => {
    expect(THEME_PRESETS.some((p) => resolveTheme(p).dark)).toBe(true);
    expect(THEME_PRESETS.some((p) => !resolveTheme(p).dark)).toBe(true);
    const cats = new Set(THEME_PRESETS.map((p) => FONT_LIBRARY[p.fonts.display]?.category));
    expect(cats).toEqual(new Set(["serif", "sans-serif"]));
  });

  it("every preset's fonts have fallback metrics (no layout shift while they load)", () => {
    for (const p of THEME_PRESETS) {
      expect(FONT_LIBRARY[p.fonts.display], `${p.name} ${p.fonts.display}`).toBeDefined();
      expect(FONT_LIBRARY[p.fonts.body], `${p.name} ${p.fonts.body}`).toBeDefined();
    }
  });

  it("looks presets up by name, case- and space-insensitively", () => {
    expect(getThemePreset(" Editorial ")?.name).toBe("editorial");
    expect(getThemePreset("nope")).toBeUndefined();
  });

  it("describes every preset on one line for a prompt", () => {
    const lines = describeThemePresets().split("\n");
    expect(lines).toHaveLength(THEME_PRESETS.length);
    THEME_PRESETS.forEach((p, i) => expect(lines[i].startsWith(`- ${p.name}: ${p.label}.`)).toBe(true));
  });
});

describe("theme presets: contrast (WCAG AA) on every surface", () => {
  for (const p of THEME_PRESETS) {
    it(p.name, () => {
      const low = pairs(p)
        .filter(([, fg, bg, min]) => contrastRatio(fg, bg) < min)
        .map(([what, fg, bg, min]) => ({ what, ratio: contrastRatio(fg, bg).toFixed(3), min }));
      expect(low).toEqual([]);
    });
  }

  it("derives readable text for a preset given only the five required colours", () => {
    const bare: ThemePreset = {
      name: "bare",
      label: "Bare",
      mood: "Test",
      fonts: { display: "Inter", body: "Inter" },
      colors: { background: "#fdfcfb", foreground: "#222222", primary: "#ffcc00", accent: "#7c3aed", muted: "#f0eee9" },
    };
    const low = pairs(bare).filter(([, fg, bg, min]) => contrastRatio(fg, bg) < min);
    expect(low).toEqual([]);
    expect(resolveTheme(bare).primary).not.toBe("#ffcc00");
  });

  it("status colours stay readable on a mid-grey ground (searches both lighter and darker)", () => {
    const mid: ThemePreset = {
      name: "mid",
      label: "Mid",
      mood: "Test",
      fonts: { display: "Inter", body: "Inter" },
      colors: { background: "#777777", foreground: "#000000", primary: "#000000", accent: "#eeeeee", muted: "#777777" },
    };
    const t = resolveTheme(mid);
    expect(contrastRatio(t.danger, t.background)).toBeGreaterThanOrEqual(AA);
    expect(contrastRatio(t.success, t.background)).toBeGreaterThanOrEqual(AA);
  });

  it("ignores a hand-picked text colour that would be unreadable", () => {
    const p = { ...THEME_PRESETS[0], colors: { ...THEME_PRESETS[0].colors, primaryForeground: THEME_PRESETS[0].colors.primary } };
    expect(contrastRatio(resolveTheme(p).primaryForeground, resolveTheme(p).primary)).toBeGreaterThanOrEqual(AA);
  });
});

describe("renderThemeCss", () => {
  const css = renderThemeCss(getThemePreset("editorial")!);

  it("starts with the web-font @import (CSS requires it before any rule)", () => {
    const firstRule = css.replace(/\/\*[\s\S]*?\*\//g, "").trim();
    expect(firstRule.startsWith('@import url("https://fonts.googleapis.com/css2?family=Fraunces:wght@')).toBe(true);
    expect(firstRule).toContain("family=Inter:wght@");
    expect(firstRule).toContain("&display=swap");
  });

  it("defines every token the starter's Tailwind config reads, on :root and the inverse/overlay surfaces", () => {
    for (const v of ["background", "foreground", "card", "card-foreground", "muted", "muted-foreground", "primary", "primary-foreground", "secondary", "secondary-foreground", "accent", "accent-foreground", "border", "input", "ring", "danger", "danger-foreground", "success", "inverse", "inverse-foreground", "radius", "font-display", "font-body", "shadow-sm", "shadow-md", "shadow-lg", "heading-weight", "heading-tracking", "heading-case"]) {
      expect(css, v).toMatch(new RegExp(`\\n  --${v}: `));
    }
    const block = (sel: string) => css.slice(css.indexOf(`${sel} {`), css.indexOf("}", css.indexOf(`${sel} {`)));
    for (const v of ["background", "foreground", "card", "muted", "muted-foreground", "primary", "primary-foreground", "border", "danger", "danger-foreground", "success"]) {
      expect(block(".surface-inverse"), `inverse --${v}`).toMatch(new RegExp(`\\n  --${v}: `));
    }
    for (const v of ["foreground", "muted-foreground", "border", "primary", "primary-foreground"]) {
      expect(block(".surface-overlay"), `overlay --${v}`).toMatch(new RegExp(`\\n  --${v}: `));
    }
    expect(css).toContain(".surface-overlay {");
    expect(css).toContain('--font-display: "Fraunces", "Fraunces Fallback", Georgia');
    expect(css).toContain('font-family: "Fraunces Fallback";');
  });

  it("is deterministic and differs between presets", () => {
    expect(renderThemeCss(getThemePreset("editorial")!)).toBe(css);
    const all = THEME_PRESETS.map(renderThemeCss);
    expect(new Set(all).size).toBe(all.length);
  });

  it("an unknown Google font still renders, with a generic fallback and no metric face", () => {
    const p = { ...THEME_PRESETS[0], fonts: { display: "Unknown Display", body: "Inter" } };
    const out = renderThemeCss(p);
    expect(out).toContain("family=Unknown+Display&family=Inter:wght@");
    expect(out).toContain('--font-display: "Unknown Display", ui-sans-serif');
    expect(out).not.toContain("Unknown Display Fallback");
  });

  it("refuses values that could break out of the stylesheet", () => {
    const base = THEME_PRESETS[0];
    expect(() => validateThemePreset({ ...base, name: "Bad Name" })).toThrow(/name/);
    expect(() => validateThemePreset({ ...base, fonts: { display: 'X"); } body { color: red', body: "Inter" } })).toThrow(/font family/);
    expect(() => validateThemePreset({ ...base, colors: { ...base.colors, primary: "red; }" } })).toThrow(/hex/);
    expect(() => validateThemePreset({ ...base, radius: "1rem; }" })).toThrow(/radius/);
    expect(() => validateThemePreset({ ...base, headingTracking: "0; }" })).toThrow(/headingTracking/);
    expect(() => validateThemePreset({ ...base, headingWeight: 950 })).toThrow(/headingWeight/);
    expect(() => validateThemePreset({ ...base, headingCase: "x; }" as "normal" })).toThrow(/headingCase/);
    const evil = renderThemeCss({ ...base, label: "x */ body { display: none } /*", mood: "*/ a{} /*" });
    expect(evil).not.toContain("display: none");
    expect(evil).not.toContain("a{}");
    expect(() => renderThemeCss({ ...base, radius: "x" })).toThrow();
  });
});
