
const SUFFIX_MULTIPLIERS: ReadonlyArray<readonly [string, number]> = [
  ["trillion", 1e12],
  ["billion", 1e9],
  ["million", 1e6],
  ["thousand", 1e3],
  ["bn", 1e9],
  ["mn", 1e6],
  ["bil", 1e9],
  ["mil", 1e6],
  ["b", 1e9],
  ["m", 1e6],
  ["k", 1e3],
  ["t", 1e12],
];

const NUMBER_TOKEN_RE =
  /(\$\s*)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(trillion|billion|million|thousand|bn|mn|bil|mil|[kmbt])?\b\s*(%)?/gi;

function applySuffix(base: number, suffixRaw: string): number {
  if (!suffixRaw) return base;
  const s = suffixRaw.toLowerCase();
  for (const [suf, mult] of SUFFIX_MULTIPLIERS) {
    if (s === suf) return base * mult;
  }
  return base;
}

export function parseHumanNumbers(text: string): number[] {
  if (!text) return [];
  const out: number[] = [];
  for (const m of text.matchAll(NUMBER_TOKEN_RE)) {
    const intPart = m[2];
    const fracPart = m[3];
    const suffix = m[4] ?? "";
    if (!intPart) continue;
    const numericStr = `${intPart.replace(/,/g, "")}${fracPart ? `.${fracPart}` : ""}`;
    const base = Number(numericStr);
    if (!Number.isFinite(base)) continue;
    out.push(applySuffix(base, suffix));
  }
  return out;
}

export function numberAppearsInText(value: number, sourceText: string, tolerancePct = 2): boolean {
  if (!Number.isFinite(value)) return false;
  const candidates = parseHumanNumbers(sourceText);
  if (candidates.length === 0) return false;
  if (value === 0) return candidates.some((c) => c === 0);
  const tol = Math.abs(value) * (tolerancePct / 100);
  return candidates.some((c) => Math.abs(c - value) <= tol);
}
