
import type { LaunchVideoTestimonial } from "./brief-mapper";

export interface TestimonialViolation {
  index: number;
  field: "source" | "quote" | "attribution";
  message: string;
  sample?: string;
}

export interface TestimonialProvenanceResult {
  ok: boolean;
  violations: TestimonialViolation[];
  kept: LaunchVideoTestimonial[];
  stripped: LaunchVideoTestimonial[];
}

const PLACEHOLDER_SOURCES = new Set([
  "n/a",
  "na",
  "none",
  "unknown",
  "tbd",
  "-",
  "--",
  "?",
  "??",
  "source",
  "example",
  "placeholder",
  "made up",
  "madeup",
  "fabricated",
  "invented",
  "test",
  "sample",
  "fake",
]);

export function hasRealSource(source: string | undefined | null): boolean {
  if (typeof source !== "string") return false;
  const t = source.trim();
  if (t.length < 3) return false;
  if (PLACEHOLDER_SOURCES.has(t.toLowerCase())) return false;
  return true;
}

function nonEmpty(s: string | undefined | null): boolean {
  return typeof s === "string" && s.trim().length > 0;
}

function truncate(s: string, n = 80): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export function checkTestimonialProvenance(
  reviews: readonly LaunchVideoTestimonial[] | undefined,
): TestimonialProvenanceResult {
  const list = reviews ?? [];
  const violations: TestimonialViolation[] = [];
  const kept: LaunchVideoTestimonial[] = [];
  const stripped: LaunchVideoTestimonial[] = [];

  list.forEach((t, index) => {
    const sample = nonEmpty(t?.quote) ? truncate(t.quote.trim()) : undefined;
    let bad = false;
    if (!nonEmpty(t?.quote)) {
      violations.push({ index, field: "quote", message: "A testimonial has no quote text.", sample });
      bad = true;
    }
    if (!nonEmpty(t?.attribution)) {
      violations.push({ index, field: "attribution", message: "A testimonial has no attribution (an anonymous claim reads as fabricated).", sample });
      bad = true;
    }
    if (!hasRealSource(t?.source)) {
      violations.push({
        index,
        field: "source",
        message: "A testimonial has no real source — a quote with no provenance is treated as fabricated.",
        sample,
      });
      bad = true;
    }
    if (bad) stripped.push(t);
    else kept.push(t);
  });

  return { ok: violations.length === 0, violations, kept, stripped };
}
