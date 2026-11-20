
export type UsdCapResult =
  | { ok: true; value: number | null }
  | { ok: false };

export function validateOptionalUsd(raw: string): UsdCapResult {
  const t = raw.trim();
  if (t === "") return { ok: true, value: null };
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return { ok: false };
  return { ok: true, value: n };
}
