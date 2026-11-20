
import {
  FONT_LIBRARY,
  THEME_CSS_PATH,
  contrastRatio,
  renderThemeCss,
  type ThemePreset,
  type ThemeShadow,
} from "@/services/provisioning/templates/vite-react-zavi/theme-presets";

export { THEME_CSS_PATH };

export const THEME_EDIT_COLORS = ["primary", "background", "foreground", "accent"] as const;
export type ThemeEditColor = (typeof THEME_EDIT_COLORS)[number];

export const THEME_RADII = ["0", "0.25rem", "0.5rem", "0.75rem", "1rem", "1.5rem"] as const;

export const THEME_FONTS: readonly string[] = Object.freeze(Object.keys(FONT_LIBRARY).sort((a, b) => a.localeCompare(b)));

export type ThemeEdit = {
  colors?: Partial<Record<ThemeEditColor, string>>;
  fonts?: { display?: string; body?: string };
  radius?: string;
};

export type ThemeTokens = {
  name: string;
  colors: Record<ThemeEditColor, string>;
  fonts: { display: string; body: string };
  radius: string;
};

const HEADER_RE = /^\/\* Theme "([a-z][a-z0-9-]{1,30})"/;
const HEX6 = /^#[0-9a-f]{6}$/i;
export const MIN_TEXT_CONTRAST = 4.5;

function rootVars(css: string): Map<string, string> | null {
  const at = css.indexOf(":root {");
  if (at < 0) return null;
  const end = css.indexOf("}", at);
  if (end < 0) return null;
  const vars = new Map<string, string>();
  for (const m of css.slice(at, end).matchAll(/--([a-z-]+):\s*([^;]+);/g)) vars.set(m[1]!, m[2]!.trim());
  return vars;
}

function blockVars(css: string, selector: string): Map<string, string> {
  const vars = new Map<string, string>();
  const at = css.indexOf(`${selector} {`);
  if (at < 0) return vars;
  const end = css.indexOf("}", at);
  for (const m of css.slice(at, end < 0 ? undefined : end).matchAll(/--([a-z-]+):\s*([^;]+);/g)) vars.set(m[1]!, m[2]!.trim());
  return vars;
}

function tripleToHex(v: string | undefined): string | null {
  const m = /^(\d{1,3}) (\d{1,3}) (\d{1,3})$/.exec((v ?? "").trim());
  if (!m) return null;
  const n = [m[1], m[2], m[3]].map(Number);
  if (n.some((x) => x > 255)) return null;
  return `#${n.map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

function firstFamily(stack: string | undefined): string | null {
  const m = /^"([A-Za-z0-9 ]{2,60})"/.exec((stack ?? "").trim());
  return m ? m[1]! : null;
}

function shadowOf(sm: string | undefined): ThemeShadow {
  const v = (sm ?? "").trim();
  if (v === "none") return "none";
  return v.startsWith("0 1px 0 0") ? "crisp" : "soft";
}

export function parseThemeCss(css: string): ThemePreset | null {
  const name = HEADER_RE.exec(css.trimStart())?.[1];
  const v = rootVars(css);
  if (!name || !v) return null;
  const hex = (k: string) => tripleToHex(v.get(k));
  const background = hex("background");
  const foreground = hex("foreground");
  const primary = hex("primary");
  const accent = hex("accent");
  const muted = hex("muted");
  const display = firstFamily(v.get("font-display"));
  const body = firstFamily(v.get("font-body"));
  if (!background || !foreground || !primary || !accent || !muted || !display || !body) return null;
  const inv = blockVars(css, ".surface-inverse");
  const optional = (value: string | null | undefined) => (value ? value : undefined);
  const weight = Number(v.get("heading-weight"));
  const preset: ThemePreset = {
    name,
    label: name,
    mood: "",
    fonts: { display, body },
    colors: {
      background,
      foreground,
      primary,
      accent,
      muted,
      card: optional(hex("card")),
      secondary: optional(hex("secondary")),
      border: optional(hex("border")),
      primaryForeground: optional(hex("primary-foreground")),
      accentForeground: optional(hex("accent-foreground")),
      mutedForeground: optional(hex("muted-foreground")),
      inverseBackground: optional(tripleToHex(inv.get("background"))),
      inverseForeground: optional(tripleToHex(inv.get("foreground"))),
    },
    radius: v.get("radius") ?? "0.5rem",
    shadow: shadowOf(v.get("shadow-sm")),
    headingWeight: Number.isInteger(weight) && weight >= 100 && weight <= 900 ? weight : 700,
    headingTracking: v.get("heading-tracking") ?? "-0.02em",
    headingCase: v.get("heading-case") === "uppercase" ? "uppercase" : "normal",
  };
  return preset;
}

export function themeTokens(preset: ThemePreset): ThemeTokens {
  const c = preset.colors;
  return {
    name: preset.name,
    colors: { primary: c.primary, background: c.background, foreground: c.foreground, accent: c.accent },
    fonts: { display: preset.fonts.display, body: preset.fonts.body },
    radius: preset.radius ?? "0.5rem",
  };
}

export type ThemeEditError = "not_platform_theme" | "bad_color" | "bad_font" | "bad_radius" | "unreadable" | "no_change";

export function cleanThemeEdit(raw: unknown): ThemeEdit | { error: ThemeEditError } | null {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: ThemeEdit = {};
  const colors = r.colors && typeof r.colors === "object" ? (r.colors as Record<string, unknown>) : {};
  for (const k of THEME_EDIT_COLORS) {
    const v = colors[k];
    if (v === undefined) continue;
    if (typeof v !== "string" || !HEX6.test(v.trim())) return { error: "bad_color" };
    (out.colors ??= {})[k] = v.trim().toLowerCase();
  }
  const fonts = r.fonts && typeof r.fonts === "object" ? (r.fonts as Record<string, unknown>) : {};
  for (const k of ["display", "body"] as const) {
    const v = fonts[k];
    if (v === undefined) continue;
    if (typeof v !== "string" || !Object.prototype.hasOwnProperty.call(FONT_LIBRARY, v)) return { error: "bad_font" };
    (out.fonts ??= {})[k] = v;
  }
  if (r.radius !== undefined) {
    if (typeof r.radius !== "string" || !(THEME_RADII as readonly string[]).includes(r.radius)) return { error: "bad_radius" };
    out.radius = r.radius;
  }
  return out.colors || out.fonts || out.radius ? out : null;
}

export function editedPreset(current: ThemePreset, edit: ThemeEdit): ThemePreset {
  const c = { ...current.colors };
  const set = edit.colors ?? {};
  const moved = (k: ThemeEditColor) => set[k] !== undefined && set[k]!.toLowerCase() !== c[k].toLowerCase();
  const page = moved("background") || moved("foreground");
  if (moved("primary")) c.primaryForeground = undefined;
  if (moved("accent")) c.accentForeground = undefined;
  if (page) {
    c.card = undefined;
    c.secondary = undefined;
    c.border = undefined;
    c.mutedForeground = undefined;
    c.inverseBackground = undefined;
    c.inverseForeground = undefined;
    c.muted = mixHex(set.background ?? c.background, set.foreground ?? c.foreground, 0.05);
  }
  for (const k of THEME_EDIT_COLORS) if (set[k] !== undefined) c[k] = set[k]!;
  return {
    ...current,
    colors: c,
    fonts: { display: edit.fonts?.display ?? current.fonts.display, body: edit.fonts?.body ?? current.fonts.body },
    radius: edit.radius ?? current.radius,
  };
}

function mixHex(a: string, b: string, t: number): string {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const x = p(a);
  const y = p(b);
  return `#${x.map((v, i) => Math.round(v + (y[i]! - v) * t).toString(16).padStart(2, "0")).join("")}`;
}

export function applyThemeEdit(css: string, edit: ThemeEdit): { css: string; tokens: ThemeTokens } | { error: ThemeEditError } {
  const current = parseThemeCss(css);
  if (!current) return { error: "not_platform_theme" };
  const next = editedPreset(current, edit);
  if (contrastRatio(next.colors.foreground, next.colors.background) < MIN_TEXT_CONTRAST) return { error: "unreadable" };
  let out: string;
  try {
    out = renderThemeCss(next);
  } catch {
    return { error: "bad_color" };
  }
  if (out === css) return { error: "no_change" };
  return { css: out, tokens: themeTokens(parseThemeCss(out) ?? next) };
}

export function themeEditMessage(error: ThemeEditError): string {
  switch (error) {
    case "not_platform_theme":
      return "This site's colours and fonts can't be changed here. Ask for the change in the chat.";
    case "bad_color":
      return "That colour isn't valid. Pick it again.";
    case "bad_font":
      return "That font isn't available. Pick one from the list.";
    case "bad_radius":
      return "Pick one of the corner styles.";
    case "unreadable":
      return "Text would be hard to read on that background. Pick a lighter or darker colour.";
    case "no_change":
      return "Nothing changed.";
  }
}

export function themeEditLabel(edit: ThemeEdit, also: string[] = []): string {
  const parts: string[] = [];
  if (edit.colors) parts.push("colours");
  if (edit.fonts) parts.push("fonts");
  if (edit.radius !== undefined) parts.push("corners");
  parts.push(...also);
  return `Changed the site's ${parts.join(", ").replace(/, ([^,]*)$/, " and $1")}`;
}
