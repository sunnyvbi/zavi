
const strs = (v: unknown, max: number): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).slice(0, max).map((x) => x.slice(0, 300)) : [];

export type CgoHoldView = { words: string[]; evidence: string | null };
export type FounderAdviceView = { warnings: string[]; unavailable?: true };

export function cgoHoldView(raw: unknown): CgoHoldView | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const h = raw as { words?: unknown; evidence?: unknown };
  const words = strs(h.words, 4);
  if (words.length === 0) return null;
  const evidence = typeof h.evidence === "string" && h.evidence.trim() ? h.evidence.trim().slice(0, 300) : null;
  return { words, evidence };
}

export function founderAdviceView(raw: unknown): FounderAdviceView | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as { warnings?: unknown; unavailable?: unknown };
  return { warnings: strs(r.warnings, 4), ...(r.unavailable === true ? { unavailable: true as const } : {}) };
}
