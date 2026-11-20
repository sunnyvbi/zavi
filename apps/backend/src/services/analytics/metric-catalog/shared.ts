
import { ExpectedToolError } from "@/services/tools/types";
import type { FetchFail, Parts } from "./types";

export function failFrom(e: unknown, label: string): FetchFail {
  if (e instanceof ExpectedToolError) {
    if (/_not_connected$|_not_configured$/.test(e.code)) {
      return { ok: false, reason: "not_connected", message: `${label} is not connected (${e.code}).` };
    }
    return { ok: false, reason: "read_failed", message: `${label} read failed (${e.code}). Retry, or tell the founder the read failed.` };
  }
  const msg = e instanceof Error ? e.message : String(e);
  return { ok: false, reason: "read_failed", message: `${label} read failed: ${msg.slice(0, 200)}` };
}

export function addParts(into: Parts, add: Parts): Parts {
  for (const [k, v] of Object.entries(add)) {
    if (Number.isFinite(v)) into[k] = (into[k] ?? 0) + v;
  }
  return into;
}

export function div(a: number | undefined, b: number | undefined): number | null {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return a / b;
}

export function sumByDate(rows: Array<{ date: string; parts: Parts }>): Array<{ date: string; parts: Parts }> {
  const by = new Map<string, Parts>();
  for (const r of rows) {
    if (!r.date) continue;
    by.set(r.date, addParts(by.get(r.date) ?? {}, r.parts));
  }
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, parts]) => ({ date, parts }));
}

export function sumByKey(
  rows: Array<{ key: string; parts: Parts }>,
  rankBy: string,
): Array<{ key: string; parts: Parts }> {
  const by = new Map<string, Parts>();
  for (const r of rows) by.set(r.key, addParts(by.get(r.key) ?? {}, r.parts));
  return [...by.entries()]
    .map(([key, parts]) => ({ key, parts }))
    .sort((a, b) => (b.parts[rankBy] ?? 0) - (a.parts[rankBy] ?? 0));
}

const ZERO_DECIMAL = new Set([
  "BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
]);

export function fromMinor(amount: number, currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? amount : amount / 100;
}
