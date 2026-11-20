
import { create as createFont, type Font } from "fontkit";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FONT_FILE = "PlusJakartaSans.ttf";
const FONT_CANDIDATES = [
  join(process.cwd(), "src/services/reports/social-image/fonts", FONT_FILE),
  join(process.cwd(), "apps/backend/src/services/reports/social-image/fonts", FONT_FILE),
  join(__dirname, "fonts", FONT_FILE),
  join(__dirname, "../../../../src/services/reports/social-image/fonts", FONT_FILE),
];

export class FontUnavailableError extends Error {
  constructor(tried: string[]) {
    super(`social-image font not found. Tried:\n${tried.join("\n")}`);
    this.name = "FontUnavailableError";
  }
}

type LoadedFont = Font;

let cached: LoadedFont | null = null;

export function loadFont(): LoadedFont {
  if (cached) return cached;
  for (const p of FONT_CANDIDATES) {
    try {
      const buf = readFileSync(p);
      const f = createFont(buf) as LoadedFont;
      cached = f;
      return f;
    } catch {
    }
  }
  throw new FontUnavailableError(FONT_CANDIDATES);
}

export function __resetFontCache(): void {
  cached = null;
}

function atWeight(font: LoadedFont, weight: number): LoadedFont {
  const anyFont = font as unknown as {
    variationAxes?: Record<string, unknown>;
    getVariation?: (v: Record<string, number>) => LoadedFont;
  };
  if (!anyFont.variationAxes?.wght || typeof anyFont.getVariation !== "function") return font;
  try {
    return anyFont.getVariation({ wght: weight });
  } catch {
    return font;
  }
}

export type TypesetResult = {
  d: string;
  width: number;
  ascent: number;
  descent: number;
};

export function typesetLine(
  text: string,
  opts: { fontSize: number; weight?: number; letterSpacing?: number },
): TypesetResult {
  const font = atWeight(loadFont(), opts.weight ?? 500);
  const upm = font.unitsPerEm;
  const scale = opts.fontSize / upm;
  const trackUnits = (opts.letterSpacing ?? 0) * upm;

  const run = font.layout(text);
  const parts: string[] = [];
  let penX = 0;

  for (let i = 0; i < run.glyphs.length; i++) {
    const glyph = run.glyphs[i];
    const pos = run.positions[i];
    const gx = penX + (pos.xOffset ?? 0);
    const gy = pos.yOffset ?? 0;
    const path = glyph.path
      .transform(1, 0, 0, -1, 0, 0)
      .translate(gx, -gy)
      .scale(scale, scale);
    const d = path.toSVG();
    if (d) parts.push(d);
    penX += (pos.xAdvance ?? 0) + trackUnits;
  }

  return {
    d: parts.join(" "),
    width: penX * scale,
    ascent: (font.ascent ?? upm * 0.8) * scale,
    descent: Math.abs(font.descent ?? upm * -0.2) * scale,
  };
}

export function measureLine(
  text: string,
  opts: { fontSize: number; weight?: number; letterSpacing?: number },
): number {
  const font = atWeight(loadFont(), opts.weight ?? 500);
  const upm = font.unitsPerEm;
  const trackUnits = (opts.letterSpacing ?? 0) * upm;
  const run = font.layout(text);
  let w = 0;
  for (const pos of run.positions) w += (pos.xAdvance ?? 0) + trackUnits;
  return (w * opts.fontSize) / upm;
}

export function wrapLines(
  text: string,
  opts: { fontSize: number; weight?: number; letterSpacing?: number; maxWidth: number },
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines: string[] = [];
  let current = words[0];
  for (let i = 1; i < words.length; i++) {
    const candidate = `${current} ${words[i]}`;
    if (measureLine(candidate, opts) <= opts.maxWidth) current = candidate;
    else {
      lines.push(current);
      current = words[i];
    }
  }
  lines.push(current);
  return lines;
}
