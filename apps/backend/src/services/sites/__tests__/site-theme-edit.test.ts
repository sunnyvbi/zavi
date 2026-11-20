import { describe, expect, it } from "vitest";
import { THEME_PRESETS, renderThemeCss, contrastRatio } from "@/services/provisioning/templates/vite-react-zavi/theme-presets";
import { TEMPLATE_FILES } from "@/services/provisioning/templates/vite-react-zavi/template-files.generated";
import { applyThemeEdit, cleanThemeEdit, parseThemeCss, themeEditLabel, themeTokens } from "../site-theme-edit";

function rootVar(css: string, name: string): string {
  const root = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
  return new RegExp(`--${name}: ([^;]+);`).exec(root)?.[1] ?? "";
}

describe("parseThemeCss", () => {
  it.each(THEME_PRESETS.map((p) => [p.name, p] as const))("reads back the %s preset so re-rendering changes nothing", (_name, preset) => {
    const css = renderThemeCss(preset);
    const parsed = parseThemeCss(css);
    expect(parsed).not.toBeNull();
    expect(renderThemeCss(parsed!)).toBe(css);
  });

  it("reads the starter's shipped theme.css", () => {
    const css = TEMPLATE_FILES["src/theme.css"]!;
    expect(parseThemeCss(css)?.name).toBe("clean");
  });

  it("refuses a file the platform did not write", () => {
    expect(parseThemeCss(":root { --primary: 1 2 3; }")).toBeNull();
    expect(parseThemeCss("")).toBeNull();
  });
});

describe("applyThemeEdit", () => {
  const shapes = ["clean", "editorial", "midnight"].map((n) => THEME_PRESETS.find((p) => p.name === n)!).filter(Boolean);

  it.each(shapes.map((p) => [p.name, p] as const))("changes only the brand colour and its button text on %s", (_n, preset) => {
    const css = renderThemeCss(preset);
    const out = applyThemeEdit(css, { colors: { primary: "#0f766e" } });
    if ("error" in out) throw new Error(out.error);
    const primary = rootVar(out.css, "primary");
    expect(out.tokens.colors.primary).toBe(`#${primary.split(" ").map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`);
    expect(primary).not.toBe(rootVar(css, "primary"));
    for (const keep of ["background", "foreground", "card", "border", "muted", "radius", "font-display", "font-body"]) {
      expect(rootVar(out.css, keep)).toBe(rootVar(css, keep));
    }
    const [r, g, b] = rootVar(out.css, "primary-foreground").split(" ").map(Number);
    const hex = `#${[r, g, b].map((n) => n!.toString(16).padStart(2, "0")).join("")}`;
    expect(contrastRatio(hex, out.tokens.colors.primary)).toBeGreaterThanOrEqual(4.5);
  });

  it("swaps fonts and corners and keeps every colour", () => {
    const css = renderThemeCss(shapes[0]!);
    const out = applyThemeEdit(css, { fonts: { display: "Fraunces", body: "Lato" }, radius: "1rem" });
    if ("error" in out) throw new Error(out.error);
    expect(out.css).toContain("family=Fraunces");
    expect(rootVar(out.css, "radius")).toBe("1rem");
    for (const keep of ["background", "foreground", "primary", "primary-foreground", "card", "border", "accent"]) {
      expect(rootVar(out.css, keep)).toBe(rootVar(css, keep));
    }
    expect(out.css.startsWith(`/* Theme "${shapes[0]!.name}"`)).toBe(true);
  });

  it("re-derives the page's tints when the page colours move", () => {
    const css = renderThemeCss(shapes[0]!);
    const out = applyThemeEdit(css, { colors: { background: "#111111", foreground: "#f5f5f5" } });
    if ("error" in out) throw new Error(out.error);
    expect(rootVar(out.css, "background")).toBe("17 17 17");
    expect(rootVar(out.css, "border")).not.toBe(rootVar(css, "border"));
  });

  it("refuses unreadable text, a no-op and a foreign file", () => {
    const css = renderThemeCss(shapes[0]!);
    expect(applyThemeEdit(css, { colors: { background: "#ffffff", foreground: "#f0f0f0" } })).toEqual({ error: "unreadable" });
    expect(applyThemeEdit(css, { colors: { primary: themeTokens(parseThemeCss(css)!).colors.primary } })).toEqual({ error: "no_change" });
    expect(applyThemeEdit("body{}", { radius: "0" })).toEqual({ error: "not_platform_theme" });
  });
});

describe("cleanThemeEdit", () => {
  it("keeps only allowlisted values", () => {
    expect(cleanThemeEdit({ colors: { primary: "#AABBCC" }, radius: "0.5rem" })).toEqual({ colors: { primary: "#aabbcc" }, radius: "0.5rem" });
    expect(cleanThemeEdit({ colors: { primary: "red" } })).toEqual({ error: "bad_color" });
    expect(cleanThemeEdit({ colors: { primary: "#000000; } body { x" } })).toEqual({ error: "bad_color" });
    expect(cleanThemeEdit({ fonts: { body: "Comic Sans" } })).toEqual({ error: "bad_font" });
    expect(cleanThemeEdit({ radius: "3px" })).toEqual({ error: "bad_radius" });
    expect(cleanThemeEdit({})).toBeNull();
  });

  it("labels the change in plain words", () => {
    expect(themeEditLabel({ colors: { primary: "#000000" } })).toBe("Changed the site's colours");
    expect(themeEditLabel({ fonts: { body: "Lato" }, radius: "0" })).toBe("Changed the site's fonts and corners");
  });
});
