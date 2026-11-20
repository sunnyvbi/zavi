
declare module "fontkit" {
  export interface Glyph {
    path: {
      toSVG(): string;
      transform(a: number, b: number, c: number, d: number, e: number, f: number): Glyph["path"];
      translate(x: number, y: number): Glyph["path"];
      scale(x: number, y: number): Glyph["path"];
    };
  }

  export interface GlyphPosition {
    xAdvance: number;
    yAdvance: number;
    xOffset: number;
    yOffset: number;
  }

  export interface GlyphRun {
    glyphs: Glyph[];
    positions: GlyphPosition[];
    advanceWidth: number;
  }

  export interface Font {
    familyName: string;
    unitsPerEm: number;
    ascent: number;
    descent: number;
    variationAxes?: Record<string, { min: number; default: number; max: number; name: string }>;
    getVariation?(settings: Record<string, number>): Font;
    layout(text: string): GlyphRun;
  }

  export function create(buffer: Buffer | Uint8Array, postscriptName?: string): Font;
  export function openSync(path: string, postscriptName?: string): Font;
}
