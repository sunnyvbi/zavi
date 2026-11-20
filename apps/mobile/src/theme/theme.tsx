
import { createContext, useContext } from "react";
import { palettes, textSelectionColorFor, type Colors, type ColorScheme } from "./tokens";

export type Theme = {
  scheme: ColorScheme;
  dark: boolean;
  colors: Colors;
  textSelectionColor: string;
  keyboardAppearance: "light" | "dark";
};

function build(scheme: ColorScheme): Theme {
  const colors = palettes[scheme];
  return {
    scheme,
    dark: scheme === "dark",
    colors,
    textSelectionColor: textSelectionColorFor(colors),
    keyboardAppearance: scheme,
  };
}

const themes: Record<ColorScheme, Theme> = { light: build("light"), dark: build("dark") };

export function themeFor(scheme: ColorScheme): Theme {
  return themes[scheme];
}

export const ThemeContext = createContext<Theme>(themes.light);

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

export type StyleFactory<T> = (colors: Colors, dark: boolean) => T;

const sheets = new WeakMap<StyleFactory<unknown>, Partial<Record<ColorScheme, unknown>>>();

function sheetFor<T>(make: StyleFactory<T>, theme: Theme): T {
  let entry = sheets.get(make as StyleFactory<unknown>);
  if (!entry) {
    entry = {};
    sheets.set(make as StyleFactory<unknown>, entry);
  }
  if (!(theme.scheme in entry)) entry[theme.scheme] = withoutFontPadding(make(theme.colors, theme.dark));
  return entry[theme.scheme] as T;
}

function withoutFontPadding<T>(sheet: T): T {
  if (!sheet || typeof sheet !== "object") return sheet;
  const out: Record<string, unknown> = {};
  for (const [key, style] of Object.entries(sheet as Record<string, unknown>)) {
    const isText =
      !!style &&
      typeof style === "object" &&
      !Array.isArray(style) &&
      ("fontSize" in style || "fontFamily" in style || "lineHeight" in style) &&
      !("includeFontPadding" in style);
    out[key] = isText ? { ...(style as object), includeFontPadding: false } : style;
  }
  return out as T;
}

export function useStyles<T>(make: StyleFactory<T>): T {
  return sheetFor(make, useTheme());
}
