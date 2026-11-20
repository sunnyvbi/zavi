
import { sanitizeFetchedContent } from "@/services/onboarding/enrichment/sanitize";

export const MAX_CUSTOM_BRANDS = 20;
export const MAX_BRAND_LEN = 60;

const URL_LIKE = /(^[a-z][a-z0-9+.-]*:\/\/)|\//i;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

export type BrandValidationResult =
  | { ok: true; brands: string[]; dropped: number }
  | { ok: false; code: "not_array" | "over_cap"; message: string };

export function validateCustomBrands(input: unknown): BrandValidationResult {
  if (!Array.isArray(input)) {
    return { ok: false, code: "not_array", message: "brands must be an array of strings" };
  }

  const seen = new Set<string>();
  const brands: string[] = [];
  let dropped = 0;

  for (const raw of input) {
    if (typeof raw !== "string") {
      dropped++;
      continue;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      dropped++;
      continue;
    }
    if (trimmed.length > MAX_BRAND_LEN) {
      dropped++;
      continue;
    }
    if (CONTROL_CHARS.test(trimmed)) {
      dropped++;
      continue;
    }
    const clean = sanitizeFetchedContent(trimmed).trim();
    if (!clean) {
      dropped++;
      continue;
    }
    if (clean.length > MAX_BRAND_LEN) {
      dropped++;
      continue;
    }
    if (URL_LIKE.test(clean)) {
      dropped++;
      continue;
    }
    const key = clean.toLowerCase();
    if (seen.has(key)) {
      dropped++;
      continue;
    }
    seen.add(key);
    brands.push(clean);
  }

  if (brands.length > MAX_CUSTOM_BRANDS) {
    return {
      ok: false,
      code: "over_cap",
      message: `too many competitors: max ${MAX_CUSTOM_BRANDS}, got ${brands.length}`,
    };
  }

  return { ok: true, brands, dropped };
}
