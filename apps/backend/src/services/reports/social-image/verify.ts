
import sharp from "sharp";
import { hexToRgb, normalizeHex } from "@/services/brand/extract-brand-colors";

export type VerifyResult = {
  ok: boolean;
  found: Record<string, number>;
  missing: string[];
  totalPixels: number;
};

const DEFAULT_MIN_PIXELS = 200;

export async function verifyBrandPixels(
  png: Buffer,
  requiredHexes: string[],
  opts?: { minPixels?: number },
): Promise<VerifyResult> {
  const minPixels = opts?.minPixels ?? DEFAULT_MIN_PIXELS;
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  const totalPixels = info.width * info.height;

  const targets = requiredHexes
    .map((h) => normalizeHex(h))
    .filter((h): h is string => Boolean(h))
    .map((hex) => ({ hex, ...hexToRgb(hex), count: 0 }));

  for (let i = 0; i < data.length; i += channels) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    for (const t of targets) {
      if (t.r === r && t.g === g && t.b === b) t.count++;
    }
  }

  const found: Record<string, number> = {};
  const missing: string[] = [];
  for (const t of targets) {
    found[t.hex] = t.count;
    if (t.count < minPixels) missing.push(t.hex);
  }
  return { ok: missing.length === 0, found, missing, totalPixels };
}
