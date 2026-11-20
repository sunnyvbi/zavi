export const THEME_COLOR = {
  light: "#F7F6F3",
  dark: "#141414",
} as const;

export const THEME_COLOR_META_SELECTOR = 'meta[name="theme-color"]';

export const THEME_KEY = "zavi:dark";

export function resolveDark(stored: string | null, systemDark: boolean): boolean {
  if (stored === "1") return true;
  if (stored === "0") return false;
  return systemDark;
}

export function applyThemeColor(dark: boolean): () => void {
  const color = dark ? THEME_COLOR.dark : THEME_COLOR.light;
  const existing = Array.from(
    document.head.querySelectorAll<HTMLMetaElement>(THEME_COLOR_META_SELECTOR),
  );
  if (existing.length === 0) {
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    meta.content = color;
    document.head.append(meta);
    return () => meta.remove();
  }
  for (const meta of existing) meta.content = color;
  return () => {};
}
