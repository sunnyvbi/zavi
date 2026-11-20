
import type { CruxDate, CruxMetricKey, PsiMetricSaving } from "./types";

export type Band = "pass" | "warn" | "fail";

export const VITAL_THRESHOLDS: Record<
  CruxMetricKey,
  {
    label: string;
    acronym: string;
    unit: "ms" | "score";
    good: number;
    poor: number;
    axisMax: number;
  }
> = {
  largest_contentful_paint: {
    label: "Largest paint",
    acronym: "LCP",
    unit: "ms",
    good: 2500,
    poor: 4000,
    axisMax: 6000,
  },
  interaction_to_next_paint: {
    label: "Tap response",
    acronym: "INP",
    unit: "ms",
    good: 200,
    poor: 500,
    axisMax: 700,
  },
  cumulative_layout_shift: {
    label: "Layout shift",
    acronym: "CLS",
    unit: "score",
    good: 0.1,
    poor: 0.25,
    axisMax: 0.5,
  },
  first_contentful_paint: {
    label: "First paint",
    acronym: "FCP",
    unit: "ms",
    good: 1800,
    poor: 3000,
    axisMax: 5000,
  },
  experimental_time_to_first_byte: {
    label: "Server response",
    acronym: "TTFB",
    unit: "ms",
    good: 800,
    poor: 1800,
    axisMax: 4000,
  },
};

export const VITAL_ORDER: CruxMetricKey[] = [
  "largest_contentful_paint",
  "interaction_to_next_paint",
  "cumulative_layout_shift",
  "first_contentful_paint",
  "experimental_time_to_first_byte",
];

export const CORE_WEB_VITALS: CruxMetricKey[] = [
  "largest_contentful_paint",
  "interaction_to_next_paint",
  "cumulative_layout_shift",
];

export function vitalBand(key: CruxMetricKey, value: number): Band {
  const t = VITAL_THRESHOLDS[key];
  if (value <= t.good) return "pass";
  if (value <= t.poor) return "warn";
  return "fail";
}

export const BAND_WORD: Record<Band, string> = {
  pass: "good",
  warn: "needs work",
  fail: "poor",
};

export function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return "-";
  if (Math.abs(ms) >= 1000) {
    const s = ms / 1000;
    return `${s >= 10 ? Math.round(s) : Number(s.toFixed(1))} s`;
  }
  return `${Math.round(ms)} ms`;
}

export function fmtScore(n: number): string {
  if (!Number.isFinite(n)) return "-";
  return n.toFixed(2);
}

export function fmtVital(key: CruxMetricKey, value: number): string {
  return VITAL_THRESHOLDS[key].unit === "ms" ? fmtMs(value) : fmtScore(value);
}

export function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "-";
  const abs = Math.abs(bytes);
  if (abs >= 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    return `${mb >= 10 ? Math.round(mb) : Number(mb.toFixed(1))} MB`;
  }
  if (abs >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes)} B`;
}

export function fmtMetricSaving(
  saving: PsiMetricSaving | undefined | null,
): string | null {
  const v = saving?.value;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  return saving?.unit === "score" ? fmtScore(v) : fmtMs(v);
}

export function positive(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

export function categoryScore100(score: number | null | undefined): number | null {
  if (typeof score !== "number" || !Number.isFinite(score)) return null;
  return Math.max(0, Math.min(100, Math.round(score * 100)));
}

export function scoreBand(score100: number): Band {
  if (score100 >= 90) return "pass";
  if (score100 >= 50) return "warn";
  return "fail";
}

export function fmtCruxDate(d: CruxDate | undefined): string | null {
  if (!d || typeof d.year !== "number" || typeof d.month !== "number") return null;
  const day = typeof d.day === "number" ? d.day : 1;
  const dt = new Date(Date.UTC(d.year, d.month - 1, day));
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function humanizeReason(reason: string | undefined | null): string | null {
  if (typeof reason !== "string") return null;
  const words = reason.replace(/[_-]+/g, " ").trim();
  if (!words) return null;
  return words.charAt(0).toLocaleUpperCase("en-US") + words.slice(1);
}

export function humanizeId(id: string | undefined | null): string | null {
  return humanizeReason(id);
}

export function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
}
