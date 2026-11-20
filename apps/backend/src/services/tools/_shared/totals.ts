
export const TOTALS_BYTE_BUDGET = 512;

export type TotalsSpec = {
  sum: readonly string[];
  ratios?: Readonly<Record<string, readonly [string, string]>>;
  scope: string;
  complete: boolean;
  note?: string;
};

export type Totals = Record<string, unknown> & {
  scope: string;
  entities: number;
  complete: boolean;
};

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function totalsBytes(totals: Totals): number {
  return Buffer.byteLength(JSON.stringify(totals), "utf-8");
}

export function buildTotals(
  rows: readonly unknown[],
  spec: TotalsSpec,
): Totals {
  const sums: Record<string, number> = {};
  for (const field of spec.sum) sums[field] = 0;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    for (const field of spec.sum) sums[field] += num(r[field]);
  }

  const out: Totals = {
    scope: spec.scope,
    entities: rows.length,
    complete: spec.complete,
  };
  for (const field of spec.sum) out[field] = round2(sums[field]);
  for (const [name, [numerator, denominator]] of Object.entries(spec.ratios ?? {})) {
    const d = sums[denominator] ?? 0;
    out[name] = d > 0 ? round2((sums[numerator] ?? 0) / d) : null;
  }
  if (!spec.complete && spec.note) out.note = spec.note;
  return out;
}
