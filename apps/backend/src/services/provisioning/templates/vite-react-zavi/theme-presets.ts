
export type ThemeShadow = "none" | "soft" | "crisp";

export type ThemePreset = {
  name: string;
  label: string;
  mood: string;
  fonts: { display: string; body: string };
  colors: {
    background: string;
    foreground: string;
    primary: string;
    accent: string;
    muted: string;
    card?: string;
    secondary?: string;
    border?: string;
    primaryForeground?: string;
    accentForeground?: string;
    mutedForeground?: string;
    inverseBackground?: string;
    inverseForeground?: string;
  };
  radius?: string;
  shadow?: ThemeShadow;
  headingWeight?: number;
  headingTracking?: string;
  headingCase?: "normal" | "uppercase";
  bestFor?: string[];
};

export const THEME_CSS_PATH = "src/theme.css";

type FontInfo = {
  category: "serif" | "sans-serif";
  weights: readonly number[];
  ascent: number;
  descent: number;
  lineGap: number;
  sizeAdjust: number;
};

export const FONT_LIBRARY: Readonly<Record<string, FontInfo>> = Object.freeze({
  Inter: { category: "sans-serif", weights: [400, 500, 600, 700, 800], ascent: 90.49, descent: 22.56, lineGap: 0, sizeAdjust: 107.06 },
  "Plus Jakarta Sans": { category: "sans-serif", weights: [400, 500, 600, 700, 800], ascent: 98.88, descent: 21.15, lineGap: 0, sizeAdjust: 104.98 },
  Fraunces: { category: "serif", weights: [400, 500, 600, 700], ascent: 84.71, descent: 22.09, lineGap: 0, sizeAdjust: 115.45 },
  "Playfair Display": { category: "serif", weights: [400, 500, 600, 700], ascent: 97.25, descent: 22.56, lineGap: 0, sizeAdjust: 111.26 },
  "Source Sans 3": { category: "sans-serif", weights: [400, 500, 600, 700], ascent: 109.21, descent: 42.66, lineGap: 0, sizeAdjust: 93.76 },
  Nunito: { category: "sans-serif", weights: [400, 500, 600, 700, 800], ascent: 99.71, descent: 34.82, lineGap: 0, sizeAdjust: 101.39 },
  "Cormorant Garamond": { category: "serif", weights: [400, 500, 600, 700], ascent: 95.27, descent: 29.59, lineGap: 0, sizeAdjust: 96.98 },
  Lato: { category: "sans-serif", weights: [400, 700], ascent: 101.03, descent: 21.8, lineGap: 0, sizeAdjust: 97.69 },
  "Space Grotesk": { category: "sans-serif", weights: [400, 500, 600, 700], ascent: 89.71, descent: 26.62, lineGap: 0, sizeAdjust: 109.69 },
  "DM Serif Display": { category: "serif", weights: [400], ascent: 94.37, descent: 30.51, lineGap: 0, sizeAdjust: 109.78 },
  "DM Sans": { category: "sans-serif", weights: [400, 500, 600, 700], ascent: 94.9, descent: 29.66, lineGap: 0, sizeAdjust: 104.53 },
  Lora: { category: "serif", weights: [400, 500, 600, 700], ascent: 87.33, descent: 23.78, lineGap: 0, sizeAdjust: 115.2 },
  "Work Sans": { category: "sans-serif", weights: [400, 500, 600, 700], ascent: 83.09, descent: 21.71, lineGap: 0, sizeAdjust: 111.93 },
  Sora: { category: "sans-serif", weights: [400, 500, 600, 700], ascent: 85.29, descent: 25.5, lineGap: 0, sizeAdjust: 113.73 },
  Outfit: { category: "sans-serif", weights: [400, 500, 600, 700], ascent: 100.18, descent: 26.05, lineGap: 0, sizeAdjust: 99.82 },
  "Bricolage Grotesque": { category: "sans-serif", weights: [400, 500, 600, 700, 800], ascent: 88.21, descent: 25.61, lineGap: 0, sizeAdjust: 105.43 },
  "Instrument Serif": { category: "serif", weights: [400], ascent: 117.94, descent: 36.93, lineGap: 0, sizeAdjust: 83.94 },
  Figtree: { category: "sans-serif", weights: [400, 500, 600, 700, 800], ascent: 94.32, descent: 24.82, lineGap: 0, sizeAdjust: 100.72 },
  Archivo: { category: "sans-serif", weights: [400, 500, 600, 700, 800], ascent: 88.96, descent: 21.28, lineGap: 0, sizeAdjust: 98.7 },
  Manrope: { category: "sans-serif", weights: [400, 500, 600, 700, 800], ascent: 103.31, descent: 29.07, lineGap: 0, sizeAdjust: 103.19 },
  Poppins: { category: "sans-serif", weights: [400, 500, 600, 700, 800], ascent: 93.62, descent: 31.21, lineGap: 8.92, sizeAdjust: 112.16 },
  Rubik: { category: "sans-serif", weights: [400, 500, 600, 700, 800], ascent: 89.06, descent: 23.81, lineGap: 0, sizeAdjust: 104.98 },
  "IBM Plex Sans": { category: "sans-serif", weights: [400, 500, 600, 700], ascent: 101.32, descent: 27.18, lineGap: 0, sizeAdjust: 101.17 },
  "Josefin Sans": { category: "sans-serif", weights: [400, 500, 600, 700], ascent: 73.32, descent: 24.44, lineGap: 0, sizeAdjust: 102.29 },
  Merriweather: { category: "serif", weights: [400, 700], ascent: 80.59, descent: 22.36, lineGap: 0, sizeAdjust: 122.09 },
  "Libre Baskerville": { category: "serif", weights: [400, 700], ascent: 76.22, descent: 21.22, lineGap: 0, sizeAdjust: 127.26 },
  "IBM Plex Serif": { category: "serif", weights: [400, 500, 600, 700], ascent: 88.04, descent: 23.62, lineGap: 0, sizeAdjust: 116.43 },
});

export const THEME_PRESETS: readonly ThemePreset[] = Object.freeze([
  {
    name: "clean",
    label: "Clean & modern",
    mood: "Crisp, bright and confident: lots of white space, one strong blue.",
    fonts: { display: "Plus Jakarta Sans", body: "Inter" },
    colors: { background: "#ffffff", foreground: "#0f172a", primary: "#2563eb", accent: "#dbeafe", muted: "#f1f5f9", inverseBackground: "#0f172a" },
    radius: "0.75rem",
    shadow: "soft",
    headingWeight: 700,
    headingTracking: "-0.025em",
    bestFor: ["professional services", "clinics", "agencies", "software", "consultants"],
  },
  {
    name: "editorial",
    label: "Warm editorial",
    mood: "Like a good magazine: warm paper, an expressive serif, terracotta details.",
    fonts: { display: "Fraunces", body: "Inter" },
    colors: { background: "#faf7f2", foreground: "#1c1917", primary: "#9a3412", accent: "#fde4cf", muted: "#f1ebe2", card: "#fffdf9", inverseBackground: "#292018" },
    radius: "0.375rem",
    shadow: "soft",
    headingWeight: 600,
    headingTracking: "-0.02em",
    bestFor: ["cafes", "bakeries", "restaurants", "bookshops", "boutiques"],
  },
  {
    name: "luxe",
    label: "Quiet luxury",
    mood: "Calm, refined and unhurried: ivory, black and a touch of gold, square corners.",
    fonts: { display: "Cormorant Garamond", body: "Lato" },
    colors: { background: "#fbf8f3", foreground: "#1a1a1a", primary: "#1a1a1a", accent: "#ead9bb", muted: "#f2ece2", card: "#fffdfa", inverseBackground: "#1a1a1a", inverseForeground: "#f4ead9" },
    radius: "0",
    shadow: "none",
    headingWeight: 500,
    headingTracking: "0",
    bestFor: ["salons", "spas", "jewellery", "weddings", "interior design"],
  },
  {
    name: "fresh",
    label: "Fresh & friendly",
    mood: "Soft, rounded and reassuring: clean whites with a calm teal.",
    fonts: { display: "Nunito", body: "Nunito" },
    colors: { background: "#ffffff", foreground: "#0f2e2a", primary: "#0f766e", accent: "#ccfbf1", muted: "#f0fdfa", inverseBackground: "#134e4a" },
    radius: "1rem",
    shadow: "soft",
    headingWeight: 800,
    headingTracking: "-0.015em",
    bestFor: ["dentists", "health and wellness", "pet care", "childcare", "cleaning"],
  },
  {
    name: "midnight",
    label: "Midnight bold",
    mood: "Dark, energetic and high-contrast: near-black with an electric lime.",
    fonts: { display: "Space Grotesk", body: "Inter" },
    colors: { background: "#0b0d12", foreground: "#f4f4f5", primary: "#a3e635", accent: "#312e81", muted: "#161a22", card: "#12151c", inverseBackground: "#a3e635", inverseForeground: "#0b0d12" },
    radius: "0.5rem",
    shadow: "crisp",
    headingWeight: 700,
    headingTracking: "-0.03em",
    bestFor: ["gyms", "music and nightlife", "tech", "gaming", "auto detailing"],
  },
  {
    name: "sunny",
    label: "Sunny & playful",
    mood: "Cheerful and generous: cream, tangerine and butter yellow.",
    fonts: { display: "DM Serif Display", body: "DM Sans" },
    colors: { background: "#fffaf0", foreground: "#2b1d0e", primary: "#c2410c", accent: "#fde68a", muted: "#fef3c7", card: "#ffffff", inverseBackground: "#7c2d12" },
    radius: "1.25rem",
    shadow: "soft",
    headingWeight: 400,
    headingTracking: "-0.01em",
    bestFor: ["ice cream and desserts", "kids activities", "food trucks", "parties and events", "florists"],
  },
  {
    name: "earthy",
    label: "Natural & earthy",
    mood: "Grounded and organic: sand, olive and a literary serif.",
    fonts: { display: "Lora", body: "Work Sans" },
    colors: { background: "#f7f5ef", foreground: "#1f2a1f", primary: "#3f6212", accent: "#e3e8c8", muted: "#ece8dc", card: "#fbfaf6", inverseBackground: "#26331f" },
    radius: "0.5rem",
    shadow: "soft",
    headingWeight: 600,
    headingTracking: "-0.01em",
    bestFor: ["landscaping", "farms and markets", "yoga", "outdoor tours", "craft makers"],
  },
  {
    name: "trust",
    label: "Trusted classic",
    mood: "Established and steady: navy, a classic serif, restrained detail.",
    fonts: { display: "Playfair Display", body: "Source Sans 3" },
    colors: { background: "#ffffff", foreground: "#0f1b2d", primary: "#1e3a5f", accent: "#ccebe7", muted: "#f2f5f8", inverseBackground: "#0f1b2d" },
    radius: "0.25rem",
    shadow: "crisp",
    headingWeight: 600,
    headingTracking: "-0.01em",
    bestFor: ["law firms", "accounting", "financial advice", "real estate", "insurance"],
  },
  {
    name: "studio",
    label: "Gallery minimal",
    mood: "The work does the talking: black on white, uppercase headings, no ornament.",
    fonts: { display: "Archivo", body: "Figtree" },
    colors: { background: "#ffffff", foreground: "#0a0a0a", primary: "#0a0a0a", accent: "#e5e5e5", muted: "#f5f5f5", inverseBackground: "#0a0a0a" },
    radius: "0",
    shadow: "none",
    headingWeight: 800,
    headingTracking: "0.02em",
    headingCase: "uppercase",
    bestFor: ["photographers", "architects", "designers", "galleries", "makers"],
  },
  {
    name: "coastal",
    label: "Coastal breeze",
    mood: "Light and airy: sea blue with a coral accent.",
    fonts: { display: "Sora", body: "Manrope" },
    colors: { background: "#f7fbfc", foreground: "#0c2a3a", primary: "#0e7490", accent: "#ffe1dc", muted: "#e6f3f6", card: "#ffffff", inverseBackground: "#0c4a5e" },
    radius: "0.75rem",
    shadow: "soft",
    headingWeight: 600,
    headingTracking: "-0.02em",
    bestFor: ["travel and rentals", "surf and boats", "swim schools", "hotels", "seafood"],
  },
  {
    name: "petal",
    label: "Soft & romantic",
    mood: "Sweet and graceful: blush pink, a soft rose and an elegant serif.",
    fonts: { display: "Instrument Serif", body: "DM Sans" },
    colors: { background: "#fff7f4", foreground: "#3a1d27", primary: "#b83b5e", accent: "#ffdbe3", muted: "#fbebe8", card: "#ffffff", inverseBackground: "#4a1f2e" },
    radius: "1rem",
    shadow: "soft",
    headingWeight: 400,
    headingTracking: "-0.01em",
    bestFor: ["cake shops", "patisseries", "florists", "bridal", "gift boutiques"],
  },
  {
    name: "active",
    label: "Active & outdoor",
    mood: "Energetic and outdoorsy: chalk white, charcoal and a vivid vermilion.",
    fonts: { display: "Bricolage Grotesque", body: "Inter" },
    colors: { background: "#f8f7f3", foreground: "#15181d", primary: "#d9431e", accent: "#ffe2d6", muted: "#efede6", card: "#ffffff", inverseBackground: "#15181d" },
    radius: "0.5rem",
    shadow: "crisp",
    headingWeight: 800,
    headingTracking: "-0.02em",
    bestFor: ["bike shops", "outdoor gear", "sports clubs", "adventure tours", "campervans"],
  },
  {
    name: "precise",
    label: "Precise product",
    mood: "Sharp and modern: off-white, graphite and a deep violet, built for software.",
    fonts: { display: "Manrope", body: "IBM Plex Sans" },
    colors: { background: "#fcfcfd", foreground: "#111114", primary: "#5b2bd6", accent: "#ece6ff", muted: "#f2f2f5", inverseBackground: "#111114" },
    radius: "0.625rem",
    shadow: "crisp",
    headingWeight: 700,
    headingTracking: "-0.03em",
    bestFor: ["software", "saas", "developer tools", "ai products", "b2b services"],
  },
  {
    name: "noir",
    label: "Dark & refined",
    mood: "Moody and crafted: deep charcoal, warm ivory and brass, a classic serif.",
    fonts: { display: "Playfair Display", body: "Figtree" },
    colors: { background: "#121110", foreground: "#f3ece0", primary: "#c9995b", accent: "#2b241d", muted: "#1c1a18", card: "#191715", inverseBackground: "#f3ece0", inverseForeground: "#121110" },
    radius: "0.25rem",
    shadow: "none",
    headingWeight: 500,
    headingTracking: "-0.01em",
    bestFor: ["tattoo studios", "cocktail bars", "barbers", "steakhouses", "fine dining"],
  },
] satisfies ThemePreset[]);

export const DEFAULT_THEME_PRESET = "clean";

export function getThemePreset(name: string): ThemePreset | undefined {
  const key = String(name ?? "").trim().toLowerCase();
  return THEME_PRESETS.find((p) => p.name === key);
}

export function describeThemePresets(presets: readonly ThemePreset[] = THEME_PRESETS, opts: { compact?: boolean } = {}): string {
  return presets
    .map((p) => {
      const suits = p.bestFor?.length ? ` Suits: ${p.bestFor.join(", ")}.` : "";
      return opts.compact ? `- ${p.name}: ${p.label}.${suits}` : `- ${p.name}: ${p.label}. ${p.mood} Fonts: ${p.fonts.display} / ${p.fonts.body}.${suits}`;
    })
    .join("\n");
}

type Rgb = [number, number, number];

export function parseHex(hex: string): Rgb {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex ?? "").trim());
  if (!m) throw new Error(`not a hex colour: ${JSON.stringify(hex)}`);
  const h = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
}

function toHex(c: Rgb): string {
  return "#" + c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("");
}

function luminance(c: Rgb): number {
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(parseHex(a));
  const lb = luminance(parseHex(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function mix(a: string, b: string, t: number): string {
  const x = parseHex(a);
  const y = parseHex(b);
  return toHex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * t) as Rgb);
}

function isDark(hex: string): boolean {
  return luminance(parseHex(hex)) < 0.2;
}

function readableOn(bg: string, candidates: string[], min = 4.5): string {
  for (const c of candidates) if (contrastRatio(c, bg) >= min) return c;
  return contrastRatio("#ffffff", bg) >= contrastRatio("#000000", bg) ? "#ffffff" : "#000000";
}

function quietText(fg: string, bgs: string[]): string {
  for (let t = 0.42; t >= 0; t -= 0.02) {
    const c = mix(fg, bgs[0], t);
    if (bgs.every((bg) => contrastRatio(c, bg) >= 4.5)) return c;
  }
  return fg;
}

const minContrast = (c: string, bgs: string[]) => Math.min(...bgs.map((bg) => contrastRatio(c, bg)));

function towardReadable(c: string, toward: string, bgs: string[]): string {
  for (let i = 0; i <= 20; i++) {
    for (const target of [toward, "#000000", "#ffffff"]) {
      const x = mix(c, target, i / 20);
      if (minContrast(x, bgs) >= 4.5) return x;
    }
  }
  return minContrast("#000000", bgs) >= minContrast("#ffffff", bgs) ? "#000000" : "#ffffff";
}

function statusOn(bgs: string[], light: string, darkShade: string): string {
  const base = minContrast(light, bgs) >= minContrast(darkShade, bgs) ? light : darkShade;
  return towardReadable(base, base === light ? "#000000" : "#ffffff", bgs);
}

function triple(hex: string): string {
  return parseHex(hex).join(" ");
}

export type ResolvedTheme = {
  background: string; foreground: string; card: string; cardForeground: string;
  muted: string; mutedForeground: string; primary: string; primaryForeground: string;
  secondary: string; secondaryForeground: string; accent: string; accentForeground: string;
  border: string; input: string; ring: string; danger: string; dangerForeground: string; success: string;
  inverse: {
    background: string; foreground: string; card: string; muted: string; mutedForeground: string;
    border: string; primary: string; primaryForeground: string; danger: string; dangerForeground: string; success: string;
  };
  overlay: { primary: string; primaryForeground: string };
  dark: boolean;
};

export const OVERLAY_DARK = "#171717";

export function resolveTheme(p: ThemePreset): ResolvedTheme {
  const c = p.colors;
  const background = toHex(parseHex(c.background));
  const foreground = toHex(parseHex(c.foreground));
  const dark = isDark(background);
  const card = c.card ? toHex(parseHex(c.card)) : background;
  const muted = toHex(parseHex(c.muted));
  const primary = towardReadable(toHex(parseHex(c.primary)), foreground, [background, muted, card]);
  const accent = toHex(parseHex(c.accent));
  const secondary = c.secondary ? toHex(parseHex(c.secondary)) : muted;
  const border = c.border ? toHex(parseHex(c.border)) : mix(background, foreground, dark ? 0.16 : 0.12);
  const ink = [foreground, background];
  const danger = statusOn([background, card], "#b91c1c", "#f87171");
  const invBg = c.inverseBackground ? toHex(parseHex(c.inverseBackground)) : foreground;
  const invFg = readableOn(invBg, [c.inverseForeground ? toHex(parseHex(c.inverseForeground)) : background, foreground, background], 7);
  const invMuted = mix(invBg, invFg, 0.08);
  const invCard = mix(invBg, invFg, 0.06);
  const invDanger = statusOn([invBg, invCard], "#b91c1c", "#f87171");
  const invPrimaryOk = contrastRatio(primary, invBg) >= 4.5;
  const invPrimary = invPrimaryOk ? primary : invFg;
  const chosen = (hex: string | undefined, bgs: string[], derived: string) =>
    hex && bgs.every((bg) => contrastRatio(toHex(parseHex(hex)), bg) >= 4.5) ? toHex(parseHex(hex)) : derived;
  const overlayPrimary = contrastRatio(primary, OVERLAY_DARK) >= 3 ? primary : "#ffffff";
  return {
    background,
    foreground,
    card,
    cardForeground: readableOn(card, ink, 7),
    muted,
    mutedForeground: chosen(c.mutedForeground, [background, muted, card], quietText(foreground, [background, muted, card])),
    primary,
    primaryForeground: chosen(c.primaryForeground, [primary], readableOn(primary, ink)),
    secondary,
    secondaryForeground: readableOn(secondary, ink, 7),
    accent,
    accentForeground: chosen(c.accentForeground, [accent], readableOn(accent, ink)),
    border,
    input: border,
    ring: primary,
    danger,
    dangerForeground: readableOn(danger, ["#ffffff", "#0b0d12"]),
    success: statusOn([background, card], "#15803d", "#4ade80"),
    inverse: {
      background: invBg,
      foreground: invFg,
      card: invCard,
      muted: invMuted,
      mutedForeground: quietText(invFg, [invBg, invMuted]),
      border: mix(invBg, invFg, 0.2),
      primary: invPrimary,
      primaryForeground: invPrimaryOk ? readableOn(primary, [invFg, invBg, foreground, background]) : invBg,
      danger: invDanger,
      dangerForeground: readableOn(invDanger, ["#ffffff", "#0b0d12"]),
      success: statusOn([invBg, invCard], "#15803d", "#4ade80"),
    },
    overlay: {
      primary: overlayPrimary,
      primaryForeground: readableOn(overlayPrimary, [foreground, background, "#0a0a0a", "#ffffff"]),
    },
    dark,
  };
}

const SHADOWS: Record<ThemeShadow, [string, string, string]> = {
  none: ["none", "none", "none"],
  soft: [
    "0 1px 2px 0 rgb(var(--shadow) / 0.05)",
    "0 1px 3px 0 rgb(var(--shadow) / 0.08), 0 8px 24px -8px rgb(var(--shadow) / 0.14)",
    "0 2px 6px 0 rgb(var(--shadow) / 0.06), 0 24px 48px -16px rgb(var(--shadow) / 0.22)",
  ],
  crisp: [
    "0 1px 0 0 rgb(var(--shadow) / 0.08)",
    "0 0 0 1px rgb(var(--shadow) / 0.06), 0 2px 4px 0 rgb(var(--shadow) / 0.1)",
    "0 0 0 1px rgb(var(--shadow) / 0.06), 0 12px 24px -6px rgb(var(--shadow) / 0.2)",
  ],
};

const FAMILY_RE = /^[A-Za-z0-9 ]{2,60}$/;
const RADIUS_RE = /^(0|\d{1,2}(\.\d{1,3})?(rem|px|em))$/;
const TRACKING_RE = /^-?(0|0?\.\d{1,3}|\d(\.\d{1,3})?)(em)?$/;

function fontStack(family: string): string {
  const info = FONT_LIBRARY[family];
  const generic = info?.category === "serif" ? 'Georgia, "Times New Roman", serif' : 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
  return info ? `"${family}", "${family} Fallback", ${generic}` : `"${family}", ${generic}`;
}

function googleFontsUrl(families: string[]): string {
  const parts = families.map((f) => {
    const family = `family=${f.replace(/ /g, "+")}`;
    const info = FONT_LIBRARY[f];
    return info ? `${family}:wght@${info.weights.join(";")}` : family;
  });
  return `https://fonts.googleapis.com/css2?${parts.join("&")}&display=swap`;
}

function fallbackFace(family: string): string {
  const info = FONT_LIBRARY[family];
  if (!info) return "";
  const local = info.category === "serif" ? "Times New Roman" : "Arial";
  return [
    `@font-face {`,
    `  font-family: "${family} Fallback";`,
    `  src: local("${local}");`,
    `  ascent-override: ${info.ascent}%;`,
    `  descent-override: ${info.descent}%;`,
    `  line-gap-override: ${info.lineGap}%;`,
    `  size-adjust: ${info.sizeAdjust}%;`,
    `}`,
  ].join("\n");
}

export function validateThemePreset(p: ThemePreset): void {
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(p.name)) throw new Error(`theme preset name ${JSON.stringify(p.name)} is invalid`);
  for (const f of [p.fonts.display, p.fonts.body]) {
    if (!FAMILY_RE.test(f)) throw new Error(`font family ${JSON.stringify(f)} is invalid`);
  }
  for (const v of Object.values(p.colors)) if (v !== undefined) parseHex(v);
  if (p.radius !== undefined && !RADIUS_RE.test(p.radius)) throw new Error(`radius ${JSON.stringify(p.radius)} is invalid`);
  if (p.headingTracking !== undefined && !TRACKING_RE.test(p.headingTracking)) throw new Error(`headingTracking ${JSON.stringify(p.headingTracking)} is invalid`);
  if (p.headingCase !== undefined && p.headingCase !== "normal" && p.headingCase !== "uppercase") throw new Error(`headingCase ${JSON.stringify(p.headingCase)} is invalid`);
  if (p.shadow !== undefined && !Object.prototype.hasOwnProperty.call(SHADOWS, p.shadow)) throw new Error(`shadow ${JSON.stringify(p.shadow)} is invalid`);
  if (p.headingWeight !== undefined && !(Number.isInteger(p.headingWeight) && p.headingWeight >= 100 && p.headingWeight <= 900)) {
    throw new Error(`headingWeight ${p.headingWeight} is invalid`);
  }
}

export function renderThemeCss(p: ThemePreset): string {
  validateThemePreset(p);
  const t = resolveTheme(p);
  const families = [...new Set([p.fonts.display, p.fonts.body])];
  const [sm, md, lg] = SHADOWS[p.shadow ?? "soft"];
  const tracking = p.headingTracking ?? "-0.02em";
  const vars = (entries: Array<[string, string]>, indent = "  ") => entries.map(([k, v]) => `${indent}--${k}: ${v};`).join("\n");
  const inv = t.inverse;
  return [
    `/* Theme "${p.name}". Written by the Zavi platform from the chosen design direction.`,
    `   Never edit this file: restyle through the tokens in src/index.css instead. Colours are`,
    `   space-separated RGB so Tailwind can apply opacity (bg-primary/10). */`,
    `@import url("${googleFontsUrl(families)}");`,
    ``,
    ...families.map(fallbackFace).filter(Boolean).flatMap((f) => [f, ""]),
    `:root {`,
    `  color-scheme: ${t.dark ? "dark" : "light"};`,
    vars([
      ["background", triple(t.background)],
      ["foreground", triple(t.foreground)],
      ["card", triple(t.card)],
      ["card-foreground", triple(t.cardForeground)],
      ["muted", triple(t.muted)],
      ["muted-foreground", triple(t.mutedForeground)],
      ["primary", triple(t.primary)],
      ["primary-foreground", triple(t.primaryForeground)],
      ["secondary", triple(t.secondary)],
      ["secondary-foreground", triple(t.secondaryForeground)],
      ["accent", triple(t.accent)],
      ["accent-foreground", triple(t.accentForeground)],
      ["border", triple(t.border)],
      ["input", triple(t.input)],
      ["ring", triple(t.ring)],
      ["danger", triple(t.danger)],
      ["danger-foreground", triple(t.dangerForeground)],
      ["success", triple(t.success)],
      ["inverse", triple(inv.background)],
      ["inverse-foreground", triple(inv.foreground)],
      ["shadow", t.dark ? "0 0 0" : triple(mix(t.foreground, "#000000", 0.5))],
      ["radius", p.radius ?? "0.5rem"],
      ["font-display", fontStack(p.fonts.display)],
      ["font-body", fontStack(p.fonts.body)],
      ["heading-weight", String(p.headingWeight ?? 700)],
      ["heading-tracking", tracking],
      ["heading-case", p.headingCase === "uppercase" ? "uppercase" : "none"],
      ["shadow-sm", sm],
      ["shadow-md", md],
      ["shadow-lg", lg],
    ]),
    `}`,
    ``,
    `/* A contrasting band (<Section tone="inverse">): every component inside reads these. */`,
    `.surface-inverse {`,
    `  color-scheme: ${isDark(inv.background) ? "dark" : "light"};`,
    vars([
      ["background", triple(inv.background)],
      ["foreground", triple(inv.foreground)],
      ["card", triple(inv.card)],
      ["card-foreground", triple(inv.foreground)],
      ["muted", triple(inv.muted)],
      ["muted-foreground", triple(inv.mutedForeground)],
      ["primary", triple(inv.primary)],
      ["primary-foreground", triple(inv.primaryForeground)],
      ["secondary", triple(inv.muted)],
      ["secondary-foreground", triple(inv.foreground)],
      ["border", triple(inv.border)],
      ["input", triple(inv.border)],
      ["ring", triple(inv.primary)],
      ["danger", triple(inv.danger)],
      ["danger-foreground", triple(inv.dangerForeground)],
      ["success", triple(inv.success)],
    ]),
    `}`,
    ``,
    `/* Text over a darkened photo (<Hero variant="image">). */`,
    `.surface-overlay {`,
    `  color-scheme: dark;`,
    vars([
      ["foreground", "255 255 255"],
      ["muted", triple(OVERLAY_DARK)],
      ["muted-foreground", "229 231 235"],
      ["border", "255 255 255"],
      ["primary", triple(t.overlay.primary)],
      ["primary-foreground", triple(t.overlay.primaryForeground)],
      ["ring", "255 255 255"],
    ]),
    `}`,
    ``,
  ].join("\n");
}

if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { writeFileSync } = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join } = require("node:path") as typeof import("node:path");
  const preset = getThemePreset(DEFAULT_THEME_PRESET);
  if (!preset) throw new Error(`default preset ${DEFAULT_THEME_PRESET} is missing`);
  const out = join(__dirname, "files", THEME_CSS_PATH);
  writeFileSync(out, renderThemeCss(preset), "utf-8");
  // eslint-disable-next-line no-console
  console.log(`wrote ${out}`);
}
