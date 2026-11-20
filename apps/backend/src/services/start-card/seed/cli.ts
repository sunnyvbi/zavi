import type { ManifestItem } from "./store";

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

export function parseMemoryFree(out: string): number {
  const m = /free percentage:\s*(\d+)%/i.exec(out);
  return m ? Number(m[1]) : 100;
}

export function readManifest(text: string): ManifestItem[] {
  const raw = JSON.parse(text) as unknown;
  if (!Array.isArray(raw)) throw new Error("manifest must be a JSON array");
  return raw.map((r, i) => {
    const o = r as { domain?: unknown; source?: unknown };
    if (typeof o.domain !== "string" || !o.domain.trim()) throw new Error(`manifest[${i}]: domain missing`);
    if (o.source !== "product_hunt" && o.source !== "yc") throw new Error(`manifest[${i}]: source must be product_hunt or yc`);
    return { domain: o.domain, source: o.source };
  });
}

export function parityVerdict(rows: Array<{ renderDelta: number | null; termMatch: boolean | null }>) {
  const deltas = rows.map((r) => r.renderDelta).filter((d): d is number => d !== null);
  const terms = rows.map((r) => r.termMatch).filter((t): t is boolean => t !== null);
  const meanDelta = deltas.length ? deltas.reduce((s, d) => s + d, 0) / deltas.length : NaN;
  const termAgree = terms.length ? terms.filter(Boolean).length / terms.length : NaN;
  const pass = deltas.length >= rows.length / 2 && Math.abs(meanDelta) <= 2 && termAgree >= 0.6;
  return { renders: deltas.length, meanDelta, terms: terms.length, termAgree, pass };
}

export function checkRef(url: string, expect: string): string {
  const ref = /^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/.exec(url)?.[1];
  if (!ref) throw new Error("SUPABASE_URL missing or not a supabase.co project URL");
  if (ref !== expect) throw new Error(`database is ${ref}, expected ${expect} (pass --expect-ref ${ref} to allow)`);
  return ref;
}

export function insideRepo(path: string, root: string, sep = "/"): boolean {
  return path === root || path.startsWith(root + sep);
}

export function positiveInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${flag} must be a whole number above 0 (got "${raw}")`);
  return n;
}
