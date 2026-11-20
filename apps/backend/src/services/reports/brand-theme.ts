
import { hexToRgb, lightness, normalizeHex } from "@/services/brand/extract-brand-colors";

export type ReportTheme = {
  ink: string;
  slate: string;
  bandRule: string;
  accentRule: string;
  mist: string;
  cloud: string;
  paper: string;
};

export type DeckTheme = {
  ink: string;
  inkMuted: string;
  accent: string;
  gold: string;
  rule: string;
  creamDeep: string;
  cream: string;
};

export const DEFAULT_REPORT_THEME: ReportTheme = {
  ink: "#191919",
  slate: "#787268",
  bandRule: "#FFC93D",
  accentRule: "#FFC93D",
  mist: "#D8D4C8",
  cloud: "#EFEDE7",
  paper: "#F7F6F3",
};

export const DEFAULT_DECK_THEME: DeckTheme = {
  ink: "#191919",
  inkMuted: "#787268",
  accent: "#0E9F6E",
  gold: "#FFC93D",
  rule: "#D8D4C8",
  creamDeep: "#EFEDE7",
  cream: "#F7F6F3",
};

export type BrandHexes = {
  primary?: string | null;
  accent?: string | null;
  source?: "scrape" | "default" | "manual" | string;
};

export const MIN_LIGHTNESS_ON_DARK = 0.4;
export const MAX_LIGHTNESS_ON_LIGHT = 0.72;

function clean(hex: string | null | undefined): string | null {
  return hex ? normalizeHex(hex) : null;
}

export function pickLegible(
  candidates: Array<string | null | undefined>,
  surface: "dark" | "light",
): string | null {
  for (const raw of candidates) {
    const hex = clean(raw);
    if (!hex) continue;
    const l = lightness(hex);
    if (surface === "dark" ? l >= MIN_LIGHTNESS_ON_DARK : l <= MAX_LIGHTNESS_ON_LIGHT) {
      return hex;
    }
  }
  return null;
}

export function isDefaultKit(kit: BrandHexes | null | undefined): boolean {
  return !kit || kit.source === "default";
}

export function reportThemeFromBrand(kit: BrandHexes | null | undefined): ReportTheme {
  if (isDefaultKit(kit)) return DEFAULT_REPORT_THEME;
  const onDark = pickLegible([kit!.accent, kit!.primary], "dark");
  const onLight = pickLegible([kit!.primary, kit!.accent], "light");
  return {
    ...DEFAULT_REPORT_THEME,
    bandRule: onDark ?? DEFAULT_REPORT_THEME.bandRule,
    accentRule: onLight ?? DEFAULT_REPORT_THEME.accentRule,
  };
}

export function deckThemeFromBrand(kit: BrandHexes | null | undefined): DeckTheme {
  if (isDefaultKit(kit)) return DEFAULT_DECK_THEME;
  const primaryFirst = pickLegible([kit!.primary, kit!.accent], "light");
  const accentFirst = pickLegible([kit!.accent, kit!.primary], "light");
  return {
    ...DEFAULT_DECK_THEME,
    accent: primaryFirst ?? DEFAULT_DECK_THEME.accent,
    gold: accentFirst ?? primaryFirst ?? DEFAULT_DECK_THEME.gold,
  };
}

export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export const MIN_TEXT_CONTRAST = 4.5;

export function pickReadable(
  candidates: Array<string | null | undefined>,
  ground: string,
  minRatio: number = MIN_TEXT_CONTRAST,
): string | null {
  for (const raw of candidates) {
    const hex = clean(raw);
    if (!hex) continue;
    if (contrastRatio(hex, ground) >= minRatio) return hex;
  }
  return null;
}

export type BlogTheme = {
  ink: string;
  slate: string;
  accent: string;
  accentText: string;
  mist: string;
  cloud: string;
  paper: string;
};

export const DEFAULT_BLOG_THEME: BlogTheme = {
  ink: "#191919",
  slate: "#787268",
  accent: "#0E9F6E",
  accentText: "#0E9F6E",
  mist: "#D8D4C8",
  cloud: "#EFEDE7",
  paper: "#F7F6F3",
};

export function blogThemeFromBrand(kit: BrandHexes | null | undefined): BlogTheme {
  if (isDefaultKit(kit)) return DEFAULT_BLOG_THEME;
  const onLight = pickLegible([kit!.primary, kit!.accent], "light");
  const onText =
    pickReadable([kit!.primary, kit!.accent], DEFAULT_BLOG_THEME.paper) ??
    pickReadable([DEFAULT_BLOG_THEME.accent], DEFAULT_BLOG_THEME.paper) ??
    DEFAULT_BLOG_THEME.ink;
  return {
    ...DEFAULT_BLOG_THEME,
    accent: onLight ?? DEFAULT_BLOG_THEME.accent,
    accentText: onText,
  };
}

export type DocTheme = {
  blue: string;
  blueSoft: string;
  blueLine: string;
  blueDark: string;
  blueSoftDark: string;
  blueLineDark: string;
};

export const DEFAULT_DOC_THEME: DocTheme = {
  blue: "#027BFF",
  blueSoft: "#EAF3FF",
  blueLine: "#B9D9FF",
  blueDark: "#62AEFF",
  blueSoftDark: "#10243B",
  blueLineDark: "#244C79",
};

const DOC_LIGHT_GROUND = "#ffffff";
const DOC_DARK_GROUND = "#0e1116";
const SOFT_LIGHT = 0.08;
const LINE_LIGHT = 0.3;
const SOFT_DARK = 0.15;
const LINE_DARK = 0.4;

export function mixHex(fg: string, bg: string, ratio: number): string {
  const fgHex = normalizeHex(fg);
  const bgHex = normalizeHex(bg);
  if (!fgHex || !bgHex || !Number.isFinite(ratio)) return bgHex ?? "#000000";
  const f = hexToRgb(fgHex);
  const b = hexToRgb(bgHex);
  const ch = (x: number, y: number) => Math.round(x * ratio + y * (1 - ratio));
  const hex = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
  return `#${hex(ch(f.r, b.r))}${hex(ch(f.g, b.g))}${hex(ch(f.b, b.b))}`;
}

export function docThemeFromBrand(kit: BrandHexes | null | undefined): DocTheme {
  if (isDefaultKit(kit)) return DEFAULT_DOC_THEME;
  const onLight = pickReadable([kit!.primary, kit!.accent], DOC_LIGHT_GROUND);
  const onDark = pickReadable([kit!.accent, kit!.primary], DOC_DARK_GROUND);
  const light: Pick<DocTheme, "blue" | "blueSoft" | "blueLine"> = onLight
    ? {
        blue: onLight,
        blueSoft: mixHex(onLight, DOC_LIGHT_GROUND, SOFT_LIGHT),
        blueLine: mixHex(onLight, DOC_LIGHT_GROUND, LINE_LIGHT),
      }
    : {
        blue: DEFAULT_DOC_THEME.blue,
        blueSoft: DEFAULT_DOC_THEME.blueSoft,
        blueLine: DEFAULT_DOC_THEME.blueLine,
      };
  const dark: Pick<DocTheme, "blueDark" | "blueSoftDark" | "blueLineDark"> = onDark
    ? {
        blueDark: onDark,
        blueSoftDark: mixHex(onDark, DOC_DARK_GROUND, SOFT_DARK),
        blueLineDark: mixHex(onDark, DOC_DARK_GROUND, LINE_DARK),
      }
    : {
        blueDark: DEFAULT_DOC_THEME.blueDark,
        blueSoftDark: DEFAULT_DOC_THEME.blueSoftDark,
        blueLineDark: DEFAULT_DOC_THEME.blueLineDark,
      };
  return { ...light, ...dark };
}
